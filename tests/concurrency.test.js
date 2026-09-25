import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { makeHarness, buildSealedPacket } from "./helpers.js";
import { EventStore } from "../src/store.js";
import { SealingWorkflow } from "../src/workflow.js";
import { ErrorCode } from "../src/errors.js";

test("并发封卷：两个秘书基于同一过期版本封卷，只有一个成功", () => {
  const h = makeHarness();
  buildSealedPacket(h, { packetId: "P1" });
  // 已封卷的重复请求沿用原结果（幂等），不抛版本冲突
  const again = h.workflow.sealPacket({ packetId: "P1" });
  assert.equal(again.deduped, true);
  assert.equal(again.result.average, 7.5);
  // 封卷事件只有一条
  const seals = h.store.readStream("review_packet", "P1").filter((e) => e.event_type === "PACKET_SEALED");
  assert.equal(seals.length, 1);
});

test("封卷过程中评审包发生变化（如新增合规决定），过期 expectedVersion 被拒绝", () => {
  const h = makeHarness();
  const w = h.workflow;
  w.registerScale({ scaleId: "std", version: 1, rubric: { d: 1 } });
  w.acceptEntry({ entryId: "C1", candidateId: "C1", qualification: { works: [] }, materials: [] });
  w.generateReviewPacket({ entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 1, scaleId: "std", scaleVersion: 1 });
  w.assignReviewer({ packetId: "P1", reviewerId: "R1" });
  w.submitScore({ sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { d: 8 }, evidenceHashes: [] });
  // 秘书甲在此时读取包版本并准备封卷
  const staleVersion = h.store.versionOf("review_packet", "P1");
  // 与此同时分配事件落到评审包流上（秘书乙的操作），甲的 expectedVersion 过期
  w.assignReviewer({ packetId: "P1", reviewerId: "R2" });
  w.submitScore({ sheetId: "S2", packetId: "P1", reviewerId: "R2", values: { d: 6 }, evidenceHashes: [] });

  assert.throws(
    () => w.sealPacket({ packetId: "P1", expectedVersion: staleVersion }),
    (err) => err.code === ErrorCode.VERSION_CONFLICT && err.details.currentVersion === staleVersion + 1,
  );
  // 用新版本重试成功
  const sealed = w.sealPacket({ packetId: "P1" });
  assert.equal(sealed.result.average, 7);
});

test("跨存储实例的并发：第二个实例落盘前重读文件，识别对方已封卷", () => {
  const h = makeHarness({ fileBacked: true });
  buildSealedPacket(h, { packetId: "P1" });
  h.workflow.publishList({ listId: "L1", stage: "prelim", packetIds: ["P1"], quota: 1 });

  const storeB = new EventStore({ path: join(h.dir, "events.jsonl"), now: () => "2026-09-01T09:00:00+08:00" });
  const wfB = new SealingWorkflow(storeB);
  // B 的内存状态来自文件，已能看到封卷；重复封卷幂等返回
  const result = wfB.sealPacket({ packetId: "P1" });
  assert.equal(result.deduped, true);
  assert.equal(storeB.readStream("review_packet", "P1").filter((e) => e.event_type === "PACKET_SEALED").length, 1);
});

test("批次原子性：批次内任一聚合版本过期时整批不落盘", () => {
  const h = makeHarness();
  buildSealedPacket(h, { packetId: "P1" });
  const before = h.store.readAll().length;
  assert.throws(() => h.store.appendBatch([
    { event: { event_type: "HOLD_PLACED", aggregate_type: "review_packet", aggregate_id: "P1", summary: "x", payload: {} } },
    {
      event: { event_type: "OUTBOX_DELIVERED", aggregate_type: "outbox_message", aggregate_id: "nope", summary: "y", payload: {} },
      expectedVersion: 5,
    },
  ]), (err) => err.code === ErrorCode.VERSION_CONFLICT);
  assert.equal(h.store.readAll().length, before, "冲突批次不得部分写入");
});
