import assert from "node:assert/strict";
import test from "node:test";

import { makeService, seedEntry } from "./helpers.js";

test("迟报关系：合规确认后只隔离生效区间内的受影响评分", async () => {
  const { service } = makeService();
  await seedEntry(service, { at: "2023-01-01T09:00:00+08:00" });

  // 同一评委在两个阶段评分：stage-1 早于关系开始，stage-2 落在关系生效期内
  await service.proposeAssignment({ assignment_id: "a1", entry_id: "entry-1", judge_id: "judge-1", stage: "stage-1", at: "2023-05-01T10:00:00+08:00" });
  await service.submitScore({ sheet_id: "s1", assignment_id: "a1", rubric_version: "rv-1", criteria: [{ name: "写作", score: 80 }], evidence_refs: ["ev-1"], at: "2023-06-01T10:00:00+08:00" });
  await service.proposeAssignment({ assignment_id: "a2", entry_id: "entry-1", judge_id: "judge-1", stage: "stage-2", at: "2025-03-01T10:00:00+08:00" });
  await service.submitScore({ sheet_id: "s2", assignment_id: "a2", rubric_version: "rv-1", criteria: [{ name: "写作", score: 88 }], evidence_refs: ["ev-2"], at: "2025-06-01T10:00:00+08:00" });
  // 另一评委在 stage-2 的评分不应受影响
  await service.proposeAssignment({ assignment_id: "a3", entry_id: "entry-1", judge_id: "judge-2", stage: "stage-2", at: "2025-03-01T11:00:00+08:00" });
  await service.submitScore({ sheet_id: "s3", assignment_id: "a3", rubric_version: "rv-1", criteria: [{ name: "写作", score: 70 }], evidence_refs: ["ev-3"], at: "2025-06-02T10:00:00+08:00" });

  // 迟报：2026-09 才披露 2024-01 至 2025-12 的共同项目（合作）关系
  await service.declareRecusal({
    recusal_id: "r1",
    judge_id: "judge-1",
    candidate_ref: "cand-A",
    relation_type: "collaboration",
    valid_from: "2024-01-01T00:00:00+08:00",
    valid_to: "2025-12-31T23:59:59+08:00",
    at: "2026-09-10T09:00:00+08:00",
  });

  // 自动提示：只有评分时间落在生效区间内的分配 a2 被标记
  const conflicts = service.listConflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].assignment_id, "a2");
  assert.equal(conflicts[0].status, "flagged");

  // 独立合规人员确认
  await service.confirmConflict({
    conflict_id: conflicts[0].conflict_id,
    confirmer_id: "compliance-1",
    decision: "confirmed",
    rationale: "共同项目属实",
    at: "2026-09-11T09:00:00+08:00",
  });

  // s2 被隔离；区间外的 s1 与其他评委的 s3 仍然有效
  const explain = service.explainCandidate("entry-1");
  const stage1 = explain.stages.find((s) => s.stage === "stage-1");
  const stage2 = explain.stages.find((s) => s.stage === "stage-2");
  assert.deepEqual(stage1.scores_used.map((s) => s.sheet_id), ["s1"]);
  assert.deepEqual(stage2.scores_used.map((s) => s.sheet_id), ["s3"]);
  assert.equal(stage2.scores_excluded.length, 1);
  assert.equal(stage2.scores_excluded[0].sheet_id, "s2");
  assert.equal(stage2.scores_excluded[0].reason, "quarantined");

  // 审计：被隔离评分保留在案中，未被删除
  assert.equal(service.getSheet("s2").status, "quarantined");
  assert.equal(service.getSheet("s2").quarantine.recusal_id, "r1");
});

test("分配前自动提示冲突，合规驳回后分配方可评分", async () => {
  const { service } = makeService();
  await seedEntry(service);
  await service.declareRecusal({
    recusal_id: "r1",
    judge_id: "judge-1",
    candidate_ref: "cand-A",
    relation_type: "mentorship",
    valid_from: "2026-01-01T00:00:00+08:00",
    valid_to: null,
    at: "2026-09-02T09:00:00+08:00",
  });

  // 分配前筛查命中回避事实：挂起等待合规确认
  const proposed = await service.proposeAssignment({ assignment_id: "a1", entry_id: "entry-1", judge_id: "judge-1", stage: "final", at: "2026-09-03T09:00:00+08:00" });
  assert.equal(proposed.status, "pending_compliance");

  // 待确认期间不能评分
  await assert.rejects(
    () => service.submitScore({ sheet_id: "s1", assignment_id: "a1", rubric_version: "rv-1", criteria: [{ name: "写作", score: 80 }], at: "2026-09-04T09:00:00+08:00" }),
    (err) => err.code === "ASSIGNMENT_NOT_ACTIVE",
  );

  // 合规驳回（误报）后分配生效，可以评分
  await service.confirmConflict({
    conflict_id: proposed.conflict_id,
    confirmer_id: "compliance-1",
    decision: "dismissed",
    rationale: "经核查不构成回避情形",
    at: "2026-09-04T12:00:00+08:00",
  });
  const result = await service.submitScore({ sheet_id: "s1", assignment_id: "a1", rubric_version: "rv-1", criteria: [{ name: "写作", score: 80 }], at: "2026-09-05T09:00:00+08:00" });
  assert.equal(result.reused, false);
});

test("冲突只能由独立合规人员确认，当事评委不得自证", async () => {
  const { service } = makeService({ complianceOfficers: ["compliance-1", "judge-1"] });
  await seedEntry(service);
  await service.declareRecusal({
    recusal_id: "r1",
    judge_id: "judge-1",
    candidate_ref: "cand-A",
    relation_type: "employment",
    valid_from: "2026-01-01T00:00:00+08:00",
    valid_to: null,
    at: "2026-09-02T09:00:00+08:00",
  });
  const proposed = await service.proposeAssignment({ assignment_id: "a1", entry_id: "entry-1", judge_id: "judge-1", stage: "final", at: "2026-09-03T09:00:00+08:00" });

  // 名单外人员不能确认
  await assert.rejects(
    () => service.confirmConflict({ conflict_id: proposed.conflict_id, confirmer_id: "outsider", decision: "confirmed", rationale: "x" }),
    (err) => err.code === "NOT_COMPLIANCE_OFFICER",
  );
  // 即使在合规名单内，当事评委也不能确认涉及自己的冲突
  await assert.rejects(
    () => service.confirmConflict({ conflict_id: proposed.conflict_id, confirmer_id: "judge-1", decision: "confirmed", rationale: "x" }),
    (err) => err.code === "SELF_CONFIRMATION",
  );
  // 独立合规人员确认后，同一冲突不能重复处理
  await service.confirmConflict({ conflict_id: proposed.conflict_id, confirmer_id: "compliance-1", decision: "confirmed", rationale: "属实" });
  await assert.rejects(
    () => service.confirmConflict({ conflict_id: proposed.conflict_id, confirmer_id: "compliance-1", decision: "dismissed", rationale: "x" }),
    (err) => err.code === "CONFLICT_ALREADY_RESOLVED",
  );
});
