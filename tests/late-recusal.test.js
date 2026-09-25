import assert from "node:assert/strict";
import test from "node:test";

import { makeHarness, buildSealedPacket } from "./helpers.js";

test("迟报关系（未封卷）：只隔离该评委评分并开替补轮，其他评委评分不受影响", () => {
  const h = makeHarness();
  const w = h.workflow;
  w.registerScale({ scaleId: "std", version: 1, rubric: { d: 1 } });
  w.acceptEntry({ entryId: "C1", candidateId: "C1", qualification: { works: ["w"] }, materials: [] });
  w.generateReviewPacket({ entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 1, scaleId: "std", scaleVersion: 1 });
  w.assignReviewer({ packetId: "P1", reviewerId: "R1" });
  w.assignReviewer({ packetId: "P1", reviewerId: "R2" });
  w.submitScore({ sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { d: 2 }, evidenceHashes: [] });
  w.submitScore({ sheetId: "S2", packetId: "P1", reviewerId: "R2", values: { d: 8 }, evidenceHashes: [] });

  h.tick("2026-09-02T08:00:00+08:00");
  const result = w.declareLateRecusal({
    factId: "F-LATE", reviewerId: "R1", candidateId: "C1",
    kind: "collaboration", detail: "终评前披露共同项目",
    validFrom: "2025-06-01T00:00:00+08:00", substituteReviewerId: "RS",
  });

  assert.deepEqual(result.affectedPackets, [
    { packetId: "P1", sheetIds: ["S1"], phase: "unsealed" },
  ]);

  const accounting = h.queries.packetAccounting("P1");
  assert.deepEqual(accounting.effective.map((s) => s.sheet_id), ["S2"], "仅 R2 评分仍有效");
  assert.deepEqual(accounting.excluded.map((s) => [s.sheet_id, s.reason]), [["S1", "late_declared_fact"]]);

  const stage = h.queries.explainCandidate("C1").stages[0];
  const recused = stage.assignments.find((a) => a.reviewer_id === "R1");
  const substitute = stage.assignments.find((a) => a.reviewer_id === "RS");
  assert.equal(recused.status, "recused");
  assert.equal(substitute.role, "substitute");
  assert.equal(substitute.round, 2);

  // 替补视图：看不到旧分、他人分、聚合分
  const view = w.reviewerView("P1", "RS");
  assert.equal(view.prior_round_scores_visible, false);
  assert.equal(view.other_scores_visible, false);
  assert.equal(view.aggregate_visible, false);
  assert.deepEqual(view.own_scores, []);
  // 原始数据事件仍保留（不删除审计）：提交与排除各一条
  const oldSheetEvents = h.store.readStream("score_sheet", "S1").map((e) => e.event_type);
  assert.deepEqual(oldSheetEvents, ["SCORE_SUBMITTED", "SCORE_EXCLUDED"]);
});

test("替补重评完成后封卷：有效集=原无关係评委+替补，旧分被排除且不向替补泄露", () => {
  const h = makeHarness();
  const w = h.workflow;
  w.registerScale({ scaleId: "std", version: 1, rubric: { d: 1 } });
  w.acceptEntry({ entryId: "C1", candidateId: "C1", qualification: { works: ["w"] }, materials: [] });
  w.generateReviewPacket({ entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 1, scaleId: "std", scaleVersion: 1 });
  w.assignReviewer({ packetId: "P1", reviewerId: "R1" });
  w.assignReviewer({ packetId: "P1", reviewerId: "R2" });
  w.submitScore({ sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { d: 10 }, evidenceHashes: [] });
  w.submitScore({ sheetId: "S2", packetId: "P1", reviewerId: "R2", values: { d: 6 }, evidenceHashes: [] });
  w.declareLateRecusal({
    factId: "F1", reviewerId: "R1", candidateId: "C1", kind: "collaboration",
    validFrom: "2025-01-01T00:00:00+08:00", substituteReviewerId: "RS",
  });
  w.submitScore({ sheetId: "S3", packetId: "P1", reviewerId: "RS", values: { d: 4 }, evidenceHashes: [] });

  const seal = w.sealPacket({ packetId: "P1" });
  assert.equal(seal.result.average, 5, "R2(6) 与替补 RS(4) 的均值");
  assert.deepEqual(seal.effective.sort(), ["S2", "S3"]);
  assert.deepEqual(seal.excluded.map((x) => x.sheet.id), ["S1"]);

  const explanation = h.queries.explainCandidate("C1").stages[0];
  assert.deepEqual(explanation.effective_scores.map((s) => s.reviewer_id).sort(), ["R2", "RS"]);
  assert.equal(explanation.excluded_scores[0].excluded_reason, "late_declared_fact");
  assert.equal(explanation.current_result.average, 5);
});

test("已公布名单不重写：迟报关系追加暂缓，替补重评后以更正决定接续", () => {
  const h = makeHarness();
  buildSealedPacket(h, {
    packetId: "P1", candidateId: "C1", stage: "prelim",
    reviewers: [{ id: "R1", values: { d: 9 } }, { id: "R2", values: { d: 5 } }],
  });
  const w = h.workflow;
  const published = w.publishList({ listId: "L1", stage: "prelim", packetIds: ["P1"], quota: 1 });
  assert.equal(published.entries[0].result, "advanced");

  h.tick("2026-09-03T08:00:00+08:00");
  const late = w.declareLateRecusal({
    factId: "F1", reviewerId: "R1", candidateId: "C1", kind: "collaboration",
    validFrom: "2025-01-01T00:00:00+08:00",
  });
  assert.equal(late.affectedPackets[0].phase, "published");

  const stage = h.queries.explainCandidate("C1").stages[0];
  assert.equal(stage.status, "held");
  const kinds = stage.decision_timeline.map((t) => t.kind);
  assert.deepEqual(kinds, ["sealed", "published", "hold"]);
  // 旧名单事件原样保留
  const listEvent = h.store.readStream("stage_list", "L1")[0];
  assert.equal(listEvent.payload.entries[0].result, "advanced");

  // 开重评轮 → 替补盲视 → 更正
  w.openRescoreRound({ packetId: "P1", substituteReviewerId: "RS", reason: "late", refId: "F1" });
  const view = w.reviewerView("P1", "RS");
  assert.equal(view.prior_round_scores_visible, false);
  w.submitScore({ sheetId: "S3", packetId: "P1", reviewerId: "RS", values: { d: 1 }, evidenceHashes: [] });
  const correction = w.issueCorrection({ packetId: "P1", reason: "late_declared_fact", refId: "F1", basis: "替补重评均值变更" });
  assert.equal(correction.previousResult.average, 7);
  assert.equal(correction.result.average, 3);

  const after = h.queries.explainCandidate("C1").stages[0];
  assert.deepEqual(after.decision_timeline.map((t) => t.kind), ["sealed", "published", "hold", "correction"]);
  assert.equal(after.current_result.via, "correction");
  assert.equal(after.current_result.average, 3);
  assert.equal(after.status, "corrected");
  // 旧封卷结果仍可在时间线中读出
  assert.equal(after.decision_timeline[0].result.average, 7);
});

test("迟报关系只影响该候选人：另一候选人的同评委评分与封卷结果保持有效", () => {
  const h = makeHarness();
  buildSealedPacket(h, { packetId: "P1", candidateId: "C1", stage: "prelim" });
  buildSealedPacket(h, { packetId: "P2", candidateId: "C2", stage: "prelim" });
  h.workflow.declareLateRecusal({
    factId: "F1", reviewerId: "R1", candidateId: "C1", kind: "collaboration",
    validFrom: "2025-01-01T00:00:00+08:00",
  });
  const c2 = h.queries.explainCandidate("C2").stages[0];
  assert.equal(c2.effective_scores.length, 2);
  assert.equal(c2.excluded_scores.length, 0);
  assert.equal(c2.current_result.average, 7.5);
});
