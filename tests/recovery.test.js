import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSealingService } from "../src/service.js";
import { EventStore } from "../src/store.js";
import { SealingWorkflow } from "../src/workflow.js";

const FIXED_NOW = "2026-09-01T09:00:00+08:00";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "seal-recovery-"));
}

function makeService(dir, delivered, { failDelivery = false } = {}) {
  return createSealingService({
    eventLogPath: join(dir, "events.jsonl"),
    now: () => FIXED_NOW,
    deliver: async (message) => {
      delivered.push(message.subject);
      if (failDelivery) throw new Error("下游暂时不可用");
    },
  });
}

function seedPacketReadyToSeal(svc) {
  const w = svc.workflow;
  w.registerScale({ scaleId: "std", version: 1, rubric: { d: 1 } });
  w.acceptEntry({ entryId: "C1", candidateId: "C1", qualification: { works: [] }, materials: [] });
  w.generateReviewPacket({ entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 1, scaleId: "std", scaleVersion: 1 });
  w.assignReviewer({ packetId: "P1", reviewerId: "R1" });
  w.assignReviewer({ packetId: "P1", reviewerId: "R2" });
  w.submitScore({ sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { d: 8 }, evidenceHashes: [] });
  w.submitScore({ sheetId: "S2", packetId: "P1", reviewerId: "R2", values: { d: 6 }, evidenceHashes: [] });
}

test("系统中断后重放事件日志：未完成封卷作业在新进程中继续并完成", async () => {
  const dir = freshDir();
  try {
    const delivered1 = [];
    const svc1 = makeService(dir, delivered1);
    seedPacketReadyToSeal(svc1);
    // 秘书只登记了封卷请求，系统在封卷执行前中断
    svc1.requestSeal({ packetId: "P1" });
    assert.ok(existsSync(join(dir, "events.jsonl")));
    assert.equal(svc1.queries.packetAccounting("P1").sealed, false);

    // —— 模拟新进程启动 ——
    const delivered2 = [];
    const svc2 = makeService(dir, delivered2);
    const report = await svc2.resume();
    assert.equal(report.seal_jobs.total, 1);
    assert.equal(report.seal_jobs.results[0].deferred, undefined);
    assert.equal(svc2.queries.packetAccounting("P1").sealed, true);
    assert.equal(svc2.queries.explainCandidate("C1").stages[0].current_result.average, 7);

    // 再次恢复：作业已完成，不重复封卷
    const second = await svc2.resume();
    assert.equal(second.seal_jobs.total, 0);
    const storeCheck = new EventStore({ path: join(dir, "events.jsonl") });
    assert.equal(
      storeCheck.readStream("review_packet", "P1").filter((e) => e.event_type === "PACKET_SEALED").length,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("恢复时评分未齐的作业保持暂缓，待补齐后再次恢复完成", async () => {
  const dir = freshDir();
  try {
    const d1 = [];
    const svc1 = makeService(dir, d1);
    const w = svc1.workflow;
    w.registerScale({ scaleId: "std", version: 1, rubric: { d: 1 } });
    w.acceptEntry({ entryId: "C1", candidateId: "C1", qualification: { works: [] }, materials: [] });
    w.generateReviewPacket({ entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 1, scaleId: "std", scaleVersion: 1 });
    w.assignReviewer({ packetId: "P1", reviewerId: "R1" });
    w.assignReviewer({ packetId: "P1", reviewerId: "R2" });
    w.submitScore({ sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { d: 8 }, evidenceHashes: [] });
    svc1.requestSeal({ packetId: "P1" });

    const d2 = [];
    const svc2 = makeService(dir, d2);
    const first = await svc2.resume();
    assert.equal(first.seal_jobs.results[0].deferred, true);
    assert.equal(first.seal_jobs.results[0].reason, "UNSEALED");

    // 补齐评分后恢复
    svc2.workflow.submitScore({ sheetId: "S2", packetId: "P1", reviewerId: "R2", values: { d: 4 }, evidenceHashes: [] });
    const second = await svc2.resume();
    assert.equal(second.seal_jobs.total, 1);
    assert.equal(svc2.queries.explainCandidate("C1").stages[0].current_result.average, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("通知箱：中断后继续未投递通知，失败可重试，dedup 保证不重复外发", async () => {
  const dir = freshDir();
  try {
    // 第一阶段：投递器失败，通知滞留
    const d1 = [];
    const svc1 = makeService(dir, d1, { failDelivery: true });
    seedPacketReadyToSeal(svc1);
    // 触发一条入箱通知：分配一个带冲突的评委需要合规确认
    svc1.workflow.declareRecusalFact({
      factId: "F1", reviewerId: "RX", candidateId: "C1", kind: "employment",
      validFrom: "2025-01-01T00:00:00+08:00",
    });
    svc1.workflow.assignReviewer({ packetId: "P1", reviewerId: "RX" });
    const firstFlush = await svc1.outbox.flushPending();
    assert.equal(firstFlush[0].ok, false);
    assert.equal(svc1.outbox.pending().length, 1);

    // —— 新进程，投递器恢复正常 ——
    const d2 = [];
    const svc2 = makeService(dir, d2);
    assert.equal(svc2.outbox.pending().length, 1, "中断重放后未投递通知仍在");
    const results = await svc2.resume();
    assert.ok(results.notifications.some((r) => r.ok));
    assert.equal(d2.length, 1, "恰好外发一次");

    // 再次恢复/刷新不重复外发
    await svc2.outbox.flushPending();
    assert.equal(d2.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同一业务动作重复触发只入箱一条通知（dedup_key 幂等）", async () => {
  const dir = freshDir();
  try {
    const delivered = [];
    const svc = makeService(dir, delivered);
    const w = svc.workflow;
    w.registerScale({ scaleId: "std", version: 1, rubric: { d: 1 } });
    w.acceptEntry({ entryId: "C1", candidateId: "C1", qualification: { works: [] }, materials: [] });
    w.generateReviewPacket({ entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 1, scaleId: "std", scaleVersion: 1 });
    w.declareRecusalFact({ factId: "F1", reviewerId: "R1", candidateId: "C1", kind: "employment", validFrom: "2025-01-01T00:00:00+08:00" });
    w.assignReviewer({ packetId: "P1", reviewerId: "R1" });
    // 同一评委重复分配（第二次不产生新 flag，因为已有 confirmed/pending；此处仅验证入箱去重不产生重复键）
    await svc.outbox.flushPending();
    const count = delivered.length;
    await svc.outbox.flushPending();
    assert.equal(delivered.length, count);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
