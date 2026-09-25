import assert from "node:assert/strict";
import test from "node:test";

import { makeService, seedEntry } from "./helpers.js";

test("跨阶段申诉：后续阶段已公布，仍可申诉更早阶段并更正", async () => {
  const { service } = makeService();
  await seedEntry(service);
  // 两个已公布阶段：entry-1 在更早的 stage-1 未晋级
  await service.publishStageList({ stage: "stage-1", advanced_entry_ids: [], at: "2026-09-05T10:00:00+08:00" });
  await service.publishStageList({ stage: "stage-2", advanced_entry_ids: [], at: "2026-09-10T10:00:00+08:00" });

  // 跨阶段：当前已推进到 stage-2，仍申诉 stage-1
  await service.openAppeal({ appeal_id: "ap-1", entry_id: "entry-1", stage: "stage-1", grounds: "评分受未披露关系影响", at: "2026-09-12T09:00:00+08:00" });

  // 材料分批到达
  await service.submitAppealMaterial({ appeal_id: "ap-1", batch_id: "b1", items: ["情况说明"], at: "2026-09-12T10:00:00+08:00" });
  await service.submitAppealMaterial({ appeal_id: "ap-1", batch_id: "b2", items: ["补充证据"], at: "2026-09-13T10:00:00+08:00" });
  // 同批次同内容幂等
  const dup = await service.submitAppealMaterial({ appeal_id: "ap-1", batch_id: "b1", items: ["情况说明"], at: "2026-09-13T11:00:00+08:00" });
  assert.equal(dup.reused, true);
  // 同批次异内容拒绝
  await assert.rejects(
    () => service.submitAppealMaterial({ appeal_id: "ap-1", batch_id: "b1", items: ["篡改内容"] }),
    (err) => err.code === "BATCH_CONFLICT",
  );

  // 裁决需要法务与业务分别签署：只有法务签署时不能裁决
  await service.signAppeal({ appeal_id: "ap-1", role: "legal", signer_id: "legal-1", outcome: "correct", at: "2026-09-14T09:00:00+08:00" });
  await assert.rejects(
    () => service.ruleAppeal({ appeal_id: "ap-1", corrected_to: "advanced" }),
    (err) => err.code === "SIGNOFF_INCOMPLETE",
  );
  // 业务签署后裁决成立
  await service.signAppeal({ appeal_id: "ap-1", role: "business", signer_id: "biz-1", outcome: "correct", at: "2026-09-14T10:00:00+08:00" });
  await service.ruleAppeal({ appeal_id: "ap-1", corrected_to: "advanced", at: "2026-09-14T11:00:00+08:00" });

  // 裁决联动追加更正决定：stage-1 有效状态由未晋级翻转为晋级
  const explain = service.explainCandidate("entry-1");
  const stage1 = explain.stages.find((s) => s.stage === "stage-1");
  assert.equal(stage1.base_status, "not_advanced");
  assert.equal(stage1.effective_status, "advanced");
  assert.equal(stage1.decisions.length, 1);
  assert.equal(stage1.decisions[0].kind, "correction");
  assert.equal(stage1.decisions[0].source, "appeal");
  assert.equal(stage1.decisions[0].appeal_id, "ap-1");

  // 已裁决申诉拒收新材料、拒绝重复签署
  await assert.rejects(
    () => service.submitAppealMaterial({ appeal_id: "ap-1", batch_id: "b3", items: ["迟到材料"] }),
    (err) => err.code === "APPEAL_CLOSED",
  );
});

test("法务与业务意见不一致不能裁决", async () => {
  const { service } = makeService();
  await seedEntry(service);
  await service.publishStageList({ stage: "final", advanced_entry_ids: ["entry-1"], at: "2026-09-05T10:00:00+08:00" });
  await service.openAppeal({ appeal_id: "ap-1", entry_id: "entry-1", stage: "final", grounds: "程序异议", at: "2026-09-06T09:00:00+08:00" });
  await service.signAppeal({ appeal_id: "ap-1", role: "legal", signer_id: "legal-1", outcome: "uphold" });
  await service.signAppeal({ appeal_id: "ap-1", role: "business", signer_id: "biz-1", outcome: "remand" });
  await assert.rejects(
    () => service.ruleAppeal({ appeal_id: "ap-1" }),
    (err) => err.code === "SIGNOFF_DIVERGED",
  );
});

test("复核裁决联动追加复核决定", async () => {
  const { service } = makeService();
  await seedEntry(service);
  await service.publishStageList({ stage: "final", advanced_entry_ids: ["entry-1"], at: "2026-09-05T10:00:00+08:00" });
  await service.openAppeal({ appeal_id: "ap-1", entry_id: "entry-1", stage: "final", grounds: "回避处理存疑", at: "2026-09-06T09:00:00+08:00" });
  await service.signAppeal({ appeal_id: "ap-1", role: "legal", signer_id: "legal-1", outcome: "remand" });
  await service.signAppeal({ appeal_id: "ap-1", role: "business", signer_id: "biz-1", outcome: "remand" });
  await service.ruleAppeal({ appeal_id: "ap-1" });

  const explain = service.explainCandidate("entry-1");
  const stage = explain.stages.find((s) => s.stage === "final");
  assert.equal(stage.effective_status, "under_review");
  assert.equal(stage.decisions[0].kind, "review");
  assert.equal(stage.decisions[0].source, "appeal");
});

test("已封卷案件不能再开启申诉", async () => {
  const { service } = makeService();
  await seedEntry(service);
  await service.publishStageList({ stage: "final", advanced_entry_ids: ["entry-1"], at: "2026-09-05T10:00:00+08:00" });
  await service.sealCase({ entry_id: "entry-1", at: "2026-09-06T09:00:00+08:00" });
  await assert.rejects(
    () => service.openAppeal({ appeal_id: "ap-1", entry_id: "entry-1", stage: "final", grounds: "x" }),
    (err) => err.code === "CASE_SEALED",
  );
});
