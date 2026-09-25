import assert from "node:assert/strict";
import test from "node:test";

import { makeService, seedEntry } from "./helpers.js";

async function seedScorable(service) {
  await seedEntry(service);
  await service.proposeAssignment({ assignment_id: "a1", entry_id: "entry-1", judge_id: "judge-1", stage: "final", at: "2026-09-02T09:00:00+08:00" });
}

const SCORE = {
  sheet_id: "s1",
  assignment_id: "a1",
  rubric_version: "rv-2026",
  criteria: [{ name: "写作", score: 85 }],
  evidence_refs: ["ev-1", "ev-2"],
};

test("评分提交即锁定量表版本与证据", async () => {
  const { service } = makeService();
  await seedScorable(service);
  await service.submitScore({ ...SCORE, at: "2026-09-03T10:00:00+08:00" });

  const sheet = service.getSheet("s1");
  assert.equal(sheet.status, "locked");
  assert.equal(sheet.versions.length, 1);
  assert.equal(sheet.versions[0].rubric_version, "rv-2026");
  assert.deepEqual(sheet.versions[0].evidence_refs, ["ev-1", "ev-2"]);
});

test("完全相同的重传沿用原结果", async () => {
  const { store, service } = makeService();
  await seedScorable(service);
  await service.submitScore({ ...SCORE, at: "2026-09-03T10:00:00+08:00" });

  // 网络重试式的完全相同重传：幂等，沿用原结果
  const again = await service.submitScore({ ...SCORE, at: "2026-09-03T10:05:00+08:00" });
  assert.equal(again.reused, true);
  assert.equal(service.getSheet("s1").versions.length, 1);

  const reusedEvents = store.all().filter((e) => e.event_type === "SCORE_RESUBMISSION_REUSED");
  assert.equal(reusedEvents.length, 1);
  // 没有产生新的提交事件
  assert.equal(store.all().filter((e) => e.event_type === "SCORE_SUBMITTED").length, 1);
});

test("同编号异内容转入调查，原结果继续有效直至解决", async () => {
  const { service } = makeService();
  await seedScorable(service);
  await service.submitScore({ ...SCORE, at: "2026-09-03T10:00:00+08:00" });

  // 同编号异内容：不覆盖，转入调查
  const attempt = await service.submitScore({
    ...SCORE,
    criteria: [{ name: "写作", score: 60 }],
    at: "2026-09-03T11:00:00+08:00",
  });
  assert.equal(attempt.investigation, true);
  assert.equal(service.getSheet("s1").status, "under_investigation");

  // 调查期间原结果继续有效
  const explain = service.explainCandidate("entry-1");
  const stage = explain.stages.find((s) => s.stage === "final");
  assert.equal(stage.scores_used.length, 1);
  assert.equal(stage.scores_used[0].total, 85);
  assert.equal(stage.scores_used[0].under_investigation, true);

  // 调查中拒绝再次变更
  await assert.rejects(
    () => service.submitScore({ ...SCORE, criteria: [{ name: "写作", score: 30 }], at: "2026-09-03T12:00:00+08:00" }),
    (err) => err.code === "INVESTIGATION_OPEN",
  );
});

test("调查解决：维持原表则恢复锁定", async () => {
  const { service } = makeService();
  await seedScorable(service);
  await service.submitScore({ ...SCORE, at: "2026-09-03T10:00:00+08:00" });
  await service.submitScore({ ...SCORE, criteria: [{ name: "写作", score: 60 }], at: "2026-09-03T11:00:00+08:00" });

  await service.resolveInvestigation({ sheet_id: "s1", resolver_id: "compliance-1", outcome: "keep_original", at: "2026-09-04T09:00:00+08:00" });
  const sheet = service.getSheet("s1");
  assert.equal(sheet.status, "locked");
  assert.equal(sheet.versions.length, 1);
  const explain = service.explainCandidate("entry-1");
  assert.equal(explain.stages[0].scores_used[0].total, 85);
});

test("调查解决：接受更正则后继版本生效，旧版本保留供审计", async () => {
  const { service } = makeService();
  await seedScorable(service);
  await service.submitScore({ ...SCORE, at: "2026-09-03T10:00:00+08:00" });
  await service.submitScore({ ...SCORE, criteria: [{ name: "写作", score: 90 }], evidence_refs: ["ev-3"], at: "2026-09-03T11:00:00+08:00" });

  await service.resolveInvestigation({ sheet_id: "s1", resolver_id: "compliance-1", outcome: "accept_correction", at: "2026-09-04T09:00:00+08:00" });
  const sheet = service.getSheet("s1");
  assert.equal(sheet.status, "locked");
  assert.equal(sheet.versions.length, 2);
  assert.equal(sheet.versions[1].sheet_version, 2);

  // 解释：当前有效为更正版，旧版以 superseded 列入排除
  const explain = service.explainCandidate("entry-1");
  const stage = explain.stages.find((s) => s.stage === "final");
  assert.equal(stage.scores_used.length, 1);
  assert.equal(stage.scores_used[0].total, 90);
  assert.equal(stage.scores_used[0].sheet_version, 2);
  const superseded = stage.scores_excluded.find((s) => s.reason === "superseded");
  assert.equal(superseded.sheet_version, 1);
  assert.equal(superseded.total, 85);
});
