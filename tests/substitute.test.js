import assert from "node:assert/strict";
import test from "node:test";

import { makeService, seedEntry } from "./helpers.js";

async function seedQuarantinedSheet(service) {
  await seedEntry(service);
  await service.proposeAssignment({ assignment_id: "a1", entry_id: "entry-1", judge_id: "judge-1", stage: "final", at: "2026-09-02T09:00:00+08:00" });
  await service.submitScore({ sheet_id: "s1", assignment_id: "a1", rubric_version: "rv-1", criteria: [{ name: "写作", score: 95 }], evidence_refs: ["ev-1"], at: "2026-09-03T10:00:00+08:00" });
  // 迟报回避并经合规确认 → s1 被隔离、a1 转为已回避
  await service.declareRecusal({
    recusal_id: "r1",
    judge_id: "judge-1",
    candidate_ref: "cand-A",
    relation_type: "collaboration",
    valid_from: "2026-01-01T00:00:00+08:00",
    valid_to: null,
    at: "2026-09-10T09:00:00+08:00",
  });
  const [conflict] = service.listConflicts();
  await service.confirmConflict({ conflict_id: conflict.conflict_id, confirmer_id: "compliance-1", decision: "confirmed", rationale: "共同项目属实", at: "2026-09-11T09:00:00+08:00" });
}

test("替补评委在看不到旧分的情况下重评", async () => {
  const { service } = makeService();
  await seedQuarantinedSheet(service);

  const replaced = await service.replaceAssignment({
    assignment_id: "a1",
    substitute_judge_id: "judge-2",
    new_assignment_id: "a2",
    at: "2026-09-12T09:00:00+08:00",
  });
  assert.equal(replaced.status, "active");

  // 替补工作台：只有脱敏评审包，看不到任何旧评分
  const workspace = service.judgeWorkspace("judge-2", "entry-1");
  assert.equal(workspace.my_sheets.length, 0);
  assert.equal(workspace.review_package.content.identity, undefined);
  assert.equal(workspace.review_package.content.contact, undefined);

  // 替补重评后：新分生效，旧分保持隔离
  await service.submitScore({ sheet_id: "s2", assignment_id: "a2", rubric_version: "rv-1", criteria: [{ name: "写作", score: 82 }], evidence_refs: ["ev-9"], at: "2026-09-13T10:00:00+08:00" });
  const explain = service.explainCandidate("entry-1");
  const stage = explain.stages.find((s) => s.stage === "final");
  assert.deepEqual(stage.scores_used.map((s) => s.sheet_id), ["s2"]);
  assert.equal(stage.scores_used[0].judge_id, "judge-2");
  assert.equal(stage.scores_excluded.length, 1);
  assert.equal(stage.scores_excluded[0].sheet_id, "s1");
  assert.equal(stage.scores_excluded[0].reason, "quarantined");
});

test("替补评委同样要经过冲突筛查", async () => {
  const { service } = makeService();
  await seedQuarantinedSheet(service);
  // 替补人选与候选人也有生效中的回避关系
  await service.declareRecusal({
    recusal_id: "r2",
    judge_id: "judge-2",
    candidate_ref: "cand-A",
    relation_type: "employment",
    valid_from: "2026-01-01T00:00:00+08:00",
    valid_to: null,
    at: "2026-09-12T08:00:00+08:00",
  });
  const replaced = await service.replaceAssignment({
    assignment_id: "a1",
    substitute_judge_id: "judge-2",
    new_assignment_id: "a2",
    at: "2026-09-12T09:00:00+08:00",
  });
  assert.equal(replaced.status, "pending_compliance");
  assert.ok(replaced.conflict_id);
});

test("未回避的分配不能替换", async () => {
  const { service } = makeService();
  await seedEntry(service);
  await service.proposeAssignment({ assignment_id: "a1", entry_id: "entry-1", judge_id: "judge-1", stage: "final", at: "2026-09-02T09:00:00+08:00" });
  await assert.rejects(
    () => service.replaceAssignment({ assignment_id: "a1", substitute_judge_id: "judge-2", new_assignment_id: "a2", at: "2026-09-03T09:00:00+08:00" }),
    (err) => err.code === "NOT_RECALLED",
  );
});
