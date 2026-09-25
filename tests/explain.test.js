import assert from "node:assert/strict";
import test from "node:test";

import { makeService, seedEntry } from "./helpers.js";

/**
 * 标题场景：评委在终评前才披露与候选人的共同项目。
 * 全程：隔离受影响评分 → 名单不重写只追加决定 → 替补盲评 →
 * 申诉双签署 → 封卷，最后由解释查询还原“为什么”。
 */
test("终评前披露共同项目：隔离、替补重评、追加决定、申诉与封卷全程可解释", async () => {
  const { store, service } = makeService();

  // 报名与脱敏评审包
  await seedEntry(service);

  // 三名评委终评
  await service.proposeAssignment({ assignment_id: "a1", entry_id: "entry-1", judge_id: "judge-1", stage: "final", at: "2026-08-01T09:00:00+08:00" });
  await service.proposeAssignment({ assignment_id: "a2", entry_id: "entry-1", judge_id: "judge-2", stage: "final", at: "2026-08-01T09:05:00+08:00" });
  await service.proposeAssignment({ assignment_id: "a3", entry_id: "entry-1", judge_id: "judge-3", stage: "final", at: "2026-08-01T09:10:00+08:00" });
  await service.submitScore({ sheet_id: "s1", assignment_id: "a1", rubric_version: "rv-2026", criteria: [{ name: "写作", score: 90 }], evidence_refs: ["ev-1"], at: "2026-08-05T10:00:00+08:00" });
  await service.submitScore({ sheet_id: "s2", assignment_id: "a2", rubric_version: "rv-2026", criteria: [{ name: "写作", score: 70 }], evidence_refs: ["ev-2"], at: "2026-08-05T11:00:00+08:00" });
  await service.submitScore({ sheet_id: "s3", assignment_id: "a3", rubric_version: "rv-2026", criteria: [{ name: "写作", score: 80 }], evidence_refs: ["ev-3"], at: "2026-08-05T12:00:00+08:00" });

  // 公布终评名单：晋级
  await service.publishStageList({ stage: "final", advanced_entry_ids: ["entry-1"], at: "2026-08-20T10:00:00+08:00" });

  // 终评前才披露共同项目（生效区间覆盖评分时间）
  await service.declareRecusal({
    recusal_id: "r1",
    judge_id: "judge-1",
    candidate_ref: "cand-A",
    relation_type: "collaboration",
    valid_from: "2026-01-01T00:00:00+08:00",
    valid_to: "2026-12-31T23:59:59+08:00",
    at: "2026-09-10T09:00:00+08:00",
  });
  const [conflict] = service.listConflicts();
  assert.equal(conflict.assignment_id, "a1");
  await service.confirmConflict({ conflict_id: conflict.conflict_id, confirmer_id: "compliance-1", decision: "confirmed", rationale: "共同项目属实", at: "2026-09-11T09:00:00+08:00" });

  // 不重写已公布名单，追加暂缓决定
  await service.appendDecision({ stage: "final", entry_id: "entry-1", kind: "hold", rationale: "回避确认，暂缓晋级待复核", at: "2026-09-11T10:00:00+08:00" });
  assert.deepEqual([...service.getStageList("final").advanced], ["entry-1"]);

  // 替补评委盲评重评
  await service.replaceAssignment({ assignment_id: "a1", substitute_judge_id: "judge-4", new_assignment_id: "a4", at: "2026-09-12T09:00:00+08:00" });
  assert.equal(service.judgeWorkspace("judge-4", "entry-1").my_sheets.length, 0);
  await service.submitScore({ sheet_id: "s4", assignment_id: "a4", rubric_version: "rv-2026", criteria: [{ name: "写作", score: 85 }], evidence_refs: ["ev-4"], at: "2026-09-13T10:00:00+08:00" });

  // 复核后更正：维持晋级
  await service.appendDecision({ stage: "final", entry_id: "entry-1", kind: "review", rationale: "替补评分完成，进入复核", at: "2026-09-14T09:00:00+08:00" });
  await service.appendDecision({ stage: "final", entry_id: "entry-1", kind: "correction", corrected_to: "advanced", rationale: "复核确认晋级有效", at: "2026-09-15T09:00:00+08:00" });

  // 申诉：材料分批到达，法务与业务分别签署后裁决维持
  await service.openAppeal({ appeal_id: "ap-1", entry_id: "entry-1", stage: "final", grounds: "对回避处理程序有异议", at: "2026-09-16T09:00:00+08:00" });
  await service.submitAppealMaterial({ appeal_id: "ap-1", batch_id: "b1", items: ["程序异议说明"], at: "2026-09-16T10:00:00+08:00" });
  await service.submitAppealMaterial({ appeal_id: "ap-1", batch_id: "b2", items: ["补充材料"], at: "2026-09-17T10:00:00+08:00" });
  await service.signAppeal({ appeal_id: "ap-1", role: "legal", signer_id: "legal-1", outcome: "uphold", at: "2026-09-18T09:00:00+08:00" });
  await service.signAppeal({ appeal_id: "ap-1", role: "business", signer_id: "biz-1", outcome: "uphold", at: "2026-09-18T10:00:00+08:00" });
  await service.ruleAppeal({ appeal_id: "ap-1", at: "2026-09-18T11:00:00+08:00" });

  // 封卷
  const sealed = await service.sealCase({ entry_id: "entry-1", at: "2026-09-19T09:00:00+08:00" });
  assert.equal(sealed.final_status, "advanced");

  // 解释查询：有效评分、排除评分及原因、决定轨迹
  const explain = service.explainCandidate("entry-1");
  const final = explain.stages.find((s) => s.stage === "final");
  assert.deepEqual(final.scores_used.map((s) => s.sheet_id), ["s2", "s3", "s4"]);
  assert.deepEqual(final.scores_excluded.map((s) => s.sheet_id), ["s1"]);
  assert.equal(final.scores_excluded[0].reason, "quarantined");
  assert.match(final.scores_excluded[0].detail, /回避隔离/);
  assert.deepEqual(
    final.status_trail.map((t) => t.status),
    ["advanced", "held", "under_review", "advanced"],
  );
  assert.equal(final.effective_status, "advanced");
  assert.equal(final.decisions.length, 3);

  // 申诉与封卷结果可解释
  assert.equal(explain.appeals.length, 1);
  assert.deepEqual(explain.appeals[0].batches, ["b1", "b2"]);
  assert.equal(explain.appeals[0].signoffs.legal.outcome, "uphold");
  assert.equal(explain.appeals[0].signoffs.business.outcome, "uphold");
  assert.equal(explain.appeals[0].ruling.outcome, "uphold");
  assert.equal(explain.sealed, true);
  assert.equal(explain.final_status, "advanced");

  // 审计：被隔离评分未被删除，事件完整保留
  const s1Events = store.all().filter((e) => e.aggregate_type === "score_sheet" && e.aggregate_id === "s1");
  assert.deepEqual(s1Events.map((e) => e.event_type), ["SCORE_SUBMITTED", "SCORE_QUARANTINED"]);
});
