import assert from "node:assert/strict";
import test from "node:test";

import { makeHarness, buildSealedPacket } from "./helpers.js";
import { ErrorCode } from "../src/errors.js";

test("申诉材料分批到达：签署后新材料到达使签署失效，法务与业务须分别重签", () => {
  const h = makeHarness();
  buildSealedPacket(h, { packetId: "P1", stage: "prelim" });
  const w = h.workflow;
  w.fileAppeal({ appealId: "A1", candidateId: "C1", targetPacketId: "P1", targetStage: "prelim", reason: "评分异常" });

  // 无材料不能签
  assert.throws(() => w.signAppeal({ appealId: "A1", role: "legal", signerId: "L1" }), /尚无申诉材料/);

  w.addAppealMaterial({ appealId: "A1", batchId: "B1", items: [{ type: "statement", hash: "h1" }] });
  w.signAppeal({ appealId: "A1", role: "legal", signerId: "L1" });
  // 仅法务签署不能裁决
  assert.throws(
    () => w.decideAppeal({ appealId: "A1", outcome: "upheld", action: "uphold" }),
    (err) => err.code === ErrorCode.PRECONDITION && err.details.missing.includes("business"),
  );
  w.signAppeal({ appealId: "A1", role: "business", signerId: "B1" });

  // 第二批材料到达：双签均失效
  const added = w.addAppealMaterial({ appealId: "A1", batchId: "B2", items: [{ type: "evidence", hash: "h2" }] });
  assert.deepEqual(added.invalidatedSignatures.sort(), ["business", "legal"]);
  assert.throws(
    () => w.decideAppeal({ appealId: "A1", outcome: "upheld", action: "uphold" }),
    (err) => err.details.missing.length === 2,
  );

  w.signAppeal({ appealId: "A1", role: "legal", signerId: "L1" });
  w.signAppeal({ appealId: "A1", role: "business", signerId: "B1" });
  const decision = w.decideAppeal({ appealId: "A1", outcome: "rejected", action: "uphold", basis: "材料不成立" });
  assert.equal(decision.action, "uphold");

  // 已裁决不可再签/再补材料
  assert.throws(() => w.addAppealMaterial({ appealId: "A1", batchId: "B3", items: [] }), /已裁决/);
  assert.throws(() => w.signAppeal({ appealId: "A1", role: "legal", signerId: "L1" }), /已裁决/);
});

test("跨阶段申诉：已公布阶段追加暂缓，下游阶段一并暂缓，旧名单不重写；替补重评后更正", () => {
  const h = makeHarness();
  // 候选人 C1 通过 prelim（P1）并在 final（P2）已封卷公布
  buildSealedPacket(h, {
    packetId: "P1", candidateId: "C1", stage: "prelim",
    reviewers: [{ id: "R1", values: { d: 9 } }, { id: "R2", values: { d: 8 } }],
  });
  buildSealedPacket(h, {
    packetId: "P2", candidateId: "C1", stage: "final",
    reviewers: [{ id: "R3", values: { d: 9 } }, { id: "R4", values: { d: 9 } }],
  });
  const w = h.workflow;
  w.publishList({ listId: "L-pre", stage: "prelim", packetIds: ["P1"], quota: 1 });
  w.publishList({ listId: "L-fin", stage: "final", packetIds: ["P2"], quota: 1 });

  // 申诉针对已公布的 prelim 阶段
  w.fileAppeal({ appealId: "A1", candidateId: "C1", targetPacketId: "P1", targetStage: "prelim", reason: "评委关系" });
  w.addAppealMaterial({ appealId: "A1", batchId: "B1", items: [{ type: "contract", hash: "h1" }] });
  w.signAppeal({ appealId: "A1", role: "legal", signerId: "L1" });
  w.signAppeal({ appealId: "A1", role: "business", signerId: "B1" });
  const decided = w.decideAppeal({
    appealId: "A1", outcome: "upheld", action: "rescore",
    stageOrder: ["prelim", "final"], basis: "合作关系属实",
  });

  const effects = Object.fromEntries(decided.effects.map((e) => [e.packet_id, e.effect]));
  assert.equal(effects.P1, "hold", "申诉所针对的已公布阶段追加暂缓");
  assert.equal(effects.P2, "downstream_hold", "更后阶段的效力一并暂缓");

  const explanation = h.queries.explainCandidate("C1");
  const p1 = explanation.stages.find((s) => s.packet_id === "P1");
  const p2 = explanation.stages.find((s) => s.packet_id === "P2");
  assert.deepEqual(p1.decision_timeline.map((t) => t.kind), ["sealed", "published", "hold"]);
  assert.equal(p1.status, "held");
  assert.deepEqual(p2.decision_timeline.map((t) => t.kind), ["sealed", "published", "hold"]);
  // 旧名单事件原样保留
  assert.equal(h.store.readStream("stage_list", "L-pre")[0].payload.entries[0].result, "advanced");
  assert.equal(h.svc.outbox.pending().length, 1);

  // 复核处置：申诉指向评委 R1，补登记迟报关系隔离其分数，替补盲视重评后更正
  w.declareLateRecusal({
    factId: "F1", reviewerId: "R1", candidateId: "C1", kind: "collaboration",
    validFrom: "2025-01-01T00:00:00+08:00",
  });
  w.openRescoreRound({ packetId: "P1", substituteReviewerId: "RS", reason: "appeal", refId: "A1" });
  const subView = w.reviewerView("P1", "RS");
  assert.equal(subView.prior_round_scores_visible, false);
  w.submitScore({ sheetId: "S5", packetId: "P1", reviewerId: "RS", values: { d: 2 }, evidenceHashes: [] });
  const correction = w.issueCorrection({ packetId: "P1", reason: "appeal_upheld", refId: "A1", basis: "替补重评" });
  assert.equal(correction.previousResult.average, 8.5);
  assert.equal(correction.result.average, 5, "R2(8) 与替补 RS(2) 的均值");

  const after = h.queries.explainCandidate("C1").stages.find((s) => s.packet_id === "P1");
  assert.deepEqual(after.decision_timeline.map((t) => t.kind), ["sealed", "published", "hold", "hold", "correction"]);
  assert.equal(after.current_result.average, 5);
  assert.deepEqual(after.excluded_scores.map((s) => s.sheet_id), ["S-P1-R1"]);
});

test("跨阶段申诉针对未公布阶段：追加复核而非暂缓", () => {
  const h = makeHarness();
  buildSealedPacket(h, {
    packetId: "P1", candidateId: "C1", stage: "prelim",
    reviewers: [{ id: "R1", values: { d: 9 } }, { id: "R2", values: { d: 8 } }],
  });
  const w = h.workflow;
  // P1 已封卷但未公布
  w.fileAppeal({ appealId: "A1", candidateId: "C1", targetPacketId: "P1", targetStage: "prelim", reason: "x" });
  w.addAppealMaterial({ appealId: "A1", batchId: "B1", items: [{ hash: "h" }] });
  w.signAppeal({ appealId: "A1", role: "legal", signerId: "L1" });
  w.signAppeal({ appealId: "A1", role: "business", signerId: "B1" });
  const decided = w.decideAppeal({ appealId: "A1", outcome: "upheld", action: "rescore" });
  assert.deepEqual(decided.effects, [{ packet_id: "P1", effect: "review" }]);
  assert.equal(h.queries.explainCandidate("C1").stages[0].status, "pending_rescore");
});

test("申诉查询可见分批材料与双签状态", () => {
  const h = makeHarness();
  buildSealedPacket(h, { packetId: "P1" });
  const w = h.workflow;
  w.fileAppeal({ appealId: "A1", candidateId: "C1", targetPacketId: "P1", targetStage: "prelim", reason: "x" });
  w.addAppealMaterial({ appealId: "A1", batchId: "B1", items: [{ hash: "h1" }], note: "首批" });
  w.addAppealMaterial({ appealId: "A1", batchId: "B2", items: [{ hash: "h2" }], note: "补充" });
  w.signAppeal({ appealId: "A1", role: "legal", signerId: "L1" });

  const appealView = h.queries.explainCandidate("C1").appeals[0];
  assert.equal(appealView.material_batches.length, 2);
  assert.equal(appealView.signatures.legal.signer_id, "L1");
  assert.equal(appealView.signatures.legal.based_on_material_batches, 2);
  assert.equal(appealView.decision, null);
});
