import assert from "node:assert/strict";
import test from "node:test";

import { makeHarness } from "./helpers.js";
import { ErrorCode } from "../src/errors.js";

function setup(h, { factFrom = "2025-01-01T00:00:00+08:00", factTo = null } = {}) {
  const w = h.workflow;
  w.registerScale({ scaleId: "std", version: 1, rubric: { d: 1 } });
  w.acceptEntry({ entryId: "C1", candidateId: "C1", qualification: { works: ["w"] }, materials: [] });
  w.declareRecusalFact({
    factId: "F1", reviewerId: "R1", candidateId: "C1", kind: "collaboration",
    detail: "共同报道项目", validFrom: factFrom, validTo: factTo,
  });
  w.generateReviewPacket({
    entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 1,
    scaleId: "std", scaleVersion: 1,
  });
}

test("分配时自动提示生效区间重叠的冲突，独立合规人员确认后评委退出并隔离评分", () => {
  const h = makeHarness();
  setup(h);
  const result = h.workflow.assignReviewer({ packetId: "P1", reviewerId: "R1" });
  assert.equal(result.conflictFlagged, true);
  assert.deepEqual(result.factIds, ["F1"]);

  // 合规确认前评分不受理
  h.workflow.assignReviewer({ packetId: "P1", reviewerId: "R2" });
  assert.throws(
    () => h.workflow.submitScore({ sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { d: 9 }, evidenceHashes: [] }),
    (err) => err.code === ErrorCode.PRECONDITION && /待合规确认/.test(err.message),
  );
  // 无签署人不能处理
  assert.throws(() => h.workflow.confirmConflict({ packetId: "P1", flagId: "F1", complianceOfficerId: null }));

  const flagId = h.queries.pendingConflictFlags()[0].flagId;
  h.workflow.confirmConflict({ packetId: "P1", flagId, complianceOfficerId: "CO-1", note: "共同项目属实" });

  const accounting = h.queries.packetAccounting("P1");
  assert.equal(accounting.pending_conflict_flags, 0);
  const assignment = h.queries.explainCandidate("C1").stages[0].assignments
    .find((a) => a.reviewer_id === "R1");
  assert.equal(assignment.status, "recused");
  // 秘书收到指派替补通知（且入箱可恢复）
  assert.ok(h.delivered.length === 0, "通知只入箱，未 flush 不外发");
});

test("合规驳回冲突后评委可正常评分，事实记录仍保留在审计轨迹", () => {
  const h = makeHarness();
  setup(h);
  h.workflow.assignReviewer({ packetId: "P1", reviewerId: "R1" });
  const flagId = h.queries.pendingConflictFlags()[0].flagId;
  h.workflow.dismissConflict({ packetId: "P1", flagId, complianceOfficerId: "CO-1", note: "区间虽重叠但项目与评审无关" });
  assert.doesNotThrow(() => h.workflow.submitScore({
    sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { d: 9 }, evidenceHashes: [],
  }));
  const stage = h.queries.explainCandidate("C1").stages[0];
  assert.equal(stage.conflict_flags[0].disposition, "dismissed");
});

test("生效区间不与评审期重叠的关系不提示冲突", () => {
  const h = makeHarness();
  setup(h, { factFrom: "2030-01-01T00:00:00+08:00" });
  const result = h.workflow.assignReviewer({ packetId: "P1", reviewerId: "R1" });
  assert.equal(result.conflictFlagged, false);
  assert.deepEqual(h.queries.pendingConflictFlags(), []);
});

test("待确认冲突未决时不能封卷", () => {
  const h = makeHarness();
  setup(h);
  h.workflow.assignReviewer({ packetId: "P1", reviewerId: "R1" });
  h.workflow.assignReviewer({ packetId: "P1", reviewerId: "R2" });
  h.workflow.submitScore({ sheetId: "S2", packetId: "P1", reviewerId: "R2", values: { d: 7 }, evidenceHashes: [] });
  assert.throws(() => h.workflow.sealPacket({ packetId: "P1" }), /冲突提示待合规确认/);
});

test("替补评委同样经过冲突自动提示与独立合规确认，确认前不能评分", () => {
  const h = makeHarness();
  const w = h.workflow;
  w.registerScale({ scaleId: "std", version: 1, rubric: { d: 1 } });
  w.acceptEntry({ entryId: "C1", candidateId: "C1", qualification: { works: ["w"] }, materials: [] });
  w.generateReviewPacket({ entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 1, scaleId: "std", scaleVersion: 1 });
  w.assignReviewer({ packetId: "P1", reviewerId: "R1" });
  w.assignReviewer({ packetId: "P1", reviewerId: "R2" });
  w.submitScore({ sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { d: 8 }, evidenceHashes: [] });
  w.submitScore({ sheetId: "S2", packetId: "P1", reviewerId: "R2", values: { d: 6 }, evidenceHashes: [] });
  // 迟报关系隔离 R1，替补 RS 恰好与 C1 也有指导关系
  w.declareRecusalFact({ factId: "F-SUB", reviewerId: "RS", candidateId: "C1", kind: "supervision", validFrom: "2024-01-01T00:00:00+08:00" });
  w.declareLateRecusal({ factId: "F1", reviewerId: "R1", candidateId: "C1", kind: "collaboration", validFrom: "2025-01-01T00:00:00+08:00", substituteReviewerId: "RS" });

  const pending = h.queries.pendingConflictFlags().map((f) => f.reviewerId);
  assert.ok(pending.includes("RS"), "替补的冲突也应进入待确认队列");
  assert.throws(
    () => w.submitScore({ sheetId: "S3", packetId: "P1", reviewerId: "RS", values: { d: 5 }, evidenceHashes: [] }),
    /待合规确认/,
  );
  // 合规确认后替补退出，封卷仍不能完成（没有替补重评分），需另派替补
  const flag = h.queries.pendingConflictFlags().find((f) => f.reviewerId === "RS");
  w.confirmConflict({ packetId: "P1", flagId: flag.flagId, complianceOfficerId: "CO1" });
  assert.throws(() => w.sealPacket({ packetId: "P1" }), /尚无有效评分/);
  // 另派无冲突替补 RS2 完成重评
  w.openSupplementalRound({ packetId: "P1", reason: "substitute_conflict", substituteReviewerId: "RS2" });
  w.submitScore({ sheetId: "S4", packetId: "P1", reviewerId: "RS2", values: { d: 4 }, evidenceHashes: [] });
  const seal = w.sealPacket({ packetId: "P1" });
  assert.deepEqual(seal.effective.sort(), ["S2", "S4"]);
});
