import assert from "node:assert/strict";
import test from "node:test";

import { makeHarness, buildSealedPacket } from "./helpers.js";

test("迟报关系（已封卷未公布）：追加复核决定，旧封卷保留，重评后更正", () => {
  const h = makeHarness();
  buildSealedPacket(h, {
    packetId: "P1", candidateId: "C1", stage: "prelim",
    reviewers: [{ id: "R1", values: { d: 9 } }, { id: "R2", values: { d: 5 } }],
  });
  const w = h.workflow;
  const late = w.declareLateRecusal({
    factId: "F1", reviewerId: "R1", candidateId: "C1", kind: "employment",
    validFrom: "2025-01-01T00:00:00+08:00",
  });
  assert.equal(late.affectedPackets[0].phase, "sealed");
  const stage = h.queries.explainCandidate("C1").stages[0];
  assert.deepEqual(stage.decision_timeline.map((t) => t.kind), ["sealed", "review"]);
  assert.equal(stage.status, "pending_rescore");
  assert.equal(stage.current_result.average, 7);

  // 复核重评完成前既不能更正，也不能公布
  assert.throws(() => w.issueCorrection({ packetId: "P1", reason: "x" }), /尚未|不能发布更正/);
  assert.throws(
    () => w.publishList({ listId: "L1", stage: "prelim", packetIds: ["P1"], quota: 1 }),
    /复核重评中/,
  );

  w.openRescoreRound({ packetId: "P1", substituteReviewerId: "RS", reason: "late", refId: "F1" });
  w.submitScore({ sheetId: "S3", packetId: "P1", reviewerId: "RS", values: { d: 1 }, evidenceHashes: [] });
  const correction = w.issueCorrection({ packetId: "P1", reason: "late_declared_fact", refId: "F1", basis: "替补重评" });
  assert.equal(correction.result.average, 3, "R2(5) 与替补 RS(1) 的均值");
  const after = h.queries.explainCandidate("C1").stages[0];
  assert.deepEqual(after.decision_timeline.map((t) => t.kind), ["sealed", "review", "correction"]);
});

test("已公布后迟报：旧名单快照保持晋级不变，包追加暂缓；更正只追加决定不回写名单", () => {
  const h = makeHarness();
  buildSealedPacket(h, {
    packetId: "P1", candidateId: "C1", stage: "prelim",
    reviewers: [{ id: "R1", values: { d: 9 } }, { id: "R2", values: { d: 9 } }],
  });
  buildSealedPacket(h, {
    packetId: "P2", candidateId: "C2", stage: "prelim",
    reviewers: [{ id: "R3", values: { d: 6 } }, { id: "R4", values: { d: 6 } }],
  });
  const w = h.workflow;
  const list = w.publishList({ listId: "L1", stage: "prelim", packetIds: ["P1", "P2"], quota: 1 });
  assert.equal(list.entries.find((e) => e.candidate_id === "C1").result, "advanced");
  assert.equal(list.entries.find((e) => e.candidate_id === "C2").result, "not_advanced");

  h.tick("2026-09-05T08:00:00+08:00");
  w.declareLateRecusal({
    factId: "F1", reviewerId: "R1", candidateId: "C1", kind: "collaboration",
    validFrom: "2025-01-01T00:00:00+08:00",
  });
  // 旧名单事件原样保留（C1 仍记录为 advanced）
  const frozenList = h.store.readStream("stage_list", "L1")[0].payload.entries;
  assert.equal(frozenList.find((e) => e.candidate_id === "C1").result, "advanced");
  assert.equal(h.queries.explainCandidate("C1").stages[0].status, "held");

  // 重评更正后：当前结果改变，名单事件依旧不变；是否递补由委员会以后续名单/决定处理
  w.openRescoreRound({ packetId: "P1", substituteReviewerId: "RS", reason: "late", refId: "F1" });
  w.submitScore({ sheetId: "S3", packetId: "P1", reviewerId: "RS", values: { d: 1 }, evidenceHashes: [] });
  w.issueCorrection({ packetId: "P1", reason: "late_declared_fact", refId: "F1", basis: "替补重评" });
  const stage = h.queries.explainCandidate("C1").stages[0];
  assert.equal(stage.current_result.average, 5);
  assert.equal(h.store.readStream("stage_list", "L1")[0].payload.entries.find((e) => e.candidate_id === "C1").result, "advanced");
  assert.deepEqual(stage.decision_timeline.map((t) => t.kind), ["sealed", "published", "hold", "correction"]);
});

test("未封卷包不能进入名单", () => {
  const h = makeHarness();
  const w = h.workflow;
  w.registerScale({ scaleId: "std", version: 1, rubric: { d: 1 } });
  w.acceptEntry({ entryId: "C1", candidateId: "C1", qualification: { works: [] }, materials: [] });
  w.generateReviewPacket({ entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 1, scaleId: "std", scaleVersion: 1 });
  assert.throws(
    () => w.publishList({ listId: "L1", stage: "prelim", packetIds: ["P1"], quota: 1 }),
    /尚未封卷/,
  );
});
