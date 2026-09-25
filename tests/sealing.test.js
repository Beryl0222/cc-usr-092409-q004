import assert from "node:assert/strict";
import test from "node:test";

import { createReviewService } from "../src/service.js";
import { makeService, seedEntry } from "./helpers.js";

test("并发封卷只有一笔成功", async () => {
  const { store, service } = makeService();
  await seedEntry(service);
  await service.publishStageList({ stage: "final", advanced_entry_ids: ["entry-1"], at: "2026-09-15T10:00:00+08:00" });

  const results = await Promise.allSettled([
    service.sealCase({ entry_id: "entry-1", at: "2026-09-16T09:00:00+08:00" }),
    service.sealCase({ entry_id: "entry-1", at: "2026-09-16T09:00:00+08:00" }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "VERSION_CONFLICT");

  // 日志中只有一笔封卷事件
  assert.equal(store.all().filter((e) => e.event_type === "CASE_SEALED").length, 1);
  // 重复封卷同样被拒绝
  await assert.rejects(
    () => service.sealCase({ entry_id: "entry-1" }),
    (err) => err.code === "CASE_SEALED",
  );
});

test("存在待确认冲突、未裁决申诉或未解决调查时不能封卷", async () => {
  // 待确认冲突
  {
    const { service } = makeService();
    await seedEntry(service);
    await service.declareRecusal({
      recusal_id: "r1", judge_id: "judge-1", candidate_ref: "cand-A",
      relation_type: "collaboration", valid_from: "2026-01-01T00:00:00+08:00", valid_to: null,
      at: "2026-09-02T09:00:00+08:00",
    });
    await service.proposeAssignment({ assignment_id: "a1", entry_id: "entry-1", judge_id: "judge-1", stage: "final", at: "2026-09-03T09:00:00+08:00" });
    await assert.rejects(() => service.sealCase({ entry_id: "entry-1" }), (err) => err.code === "PENDING_CONFLICT");
  }
  // 未裁决申诉
  {
    const { service } = makeService();
    await seedEntry(service);
    await service.publishStageList({ stage: "final", advanced_entry_ids: ["entry-1"], at: "2026-09-05T10:00:00+08:00" });
    await service.openAppeal({ appeal_id: "ap-1", entry_id: "entry-1", stage: "final", grounds: "x", at: "2026-09-06T09:00:00+08:00" });
    await assert.rejects(() => service.sealCase({ entry_id: "entry-1" }), (err) => err.code === "OPEN_APPEAL");
  }
  // 未解决调查
  {
    const { service } = makeService();
    await seedEntry(service);
    await service.proposeAssignment({ assignment_id: "a1", entry_id: "entry-1", judge_id: "judge-1", stage: "final", at: "2026-09-02T09:00:00+08:00" });
    await service.submitScore({ sheet_id: "s1", assignment_id: "a1", rubric_version: "rv-1", criteria: [{ name: "写作", score: 80 }], at: "2026-09-03T09:00:00+08:00" });
    await service.submitScore({ sheet_id: "s1", assignment_id: "a1", rubric_version: "rv-1", criteria: [{ name: "写作", score: 60 }], at: "2026-09-03T10:00:00+08:00" });
    await assert.rejects(() => service.sealCase({ entry_id: "entry-1" }), (err) => err.code === "OPEN_INVESTIGATION");
  }
});

test("系统中断后恢复：补发通知、继续未封卷案件", async () => {
  const { store, service } = makeService();
  await seedEntry(service, { entry_id: "entry-1", candidate_ref: "cand-A" });
  await seedEntry(service, { entry_id: "entry-2", candidate_ref: "cand-B" });
  await service.publishStageList({ stage: "final", advanced_entry_ids: ["entry-1", "entry-2"], at: "2026-09-15T10:00:00+08:00" });
  await service.proposeAssignment({ assignment_id: "a9", entry_id: "entry-1", judge_id: "judge-9", stage: "final", at: "2026-09-15T11:00:00+08:00" });
  await service.sealCase({ entry_id: "entry-1", at: "2026-09-16T09:00:00+08:00" });

  // 模拟系统中断：通知尚未发送，在同一事件库上重建服务
  const revived = createReviewService({ store, complianceOfficers: ["compliance-1"] });
  const report = await revived.resume({ at: "2026-09-17T09:00:00+08:00" });
  assert.deepEqual(report.notifications_sent, ["notif-entry-1-case_sealed"]);
  assert.deepEqual(report.unsealed_entries, ["entry-2"]);

  // 重复恢复不会重复发送通知（幂等）
  const again = await revived.resume({ at: "2026-09-17T09:05:00+08:00" });
  assert.deepEqual(again.notifications_sent, []);

  // 继续办理未封卷案件
  const sealed = await revived.sealCase({ entry_id: "entry-2", at: "2026-09-17T10:00:00+08:00" });
  assert.equal(sealed.final_status, "advanced");
  await revived.flushNotifications({ at: "2026-09-17T10:01:00+08:00" });

  // 已封卷案件拒绝任何变更
  await assert.rejects(
    () => revived.submitScore({ sheet_id: "s9", assignment_id: "a9", rubric_version: "rv-1", criteria: [{ name: "写作", score: 1 }], at: "2026-09-17T11:00:00+08:00" }),
    (err) => err.code === "CASE_SEALED",
  );
  await assert.rejects(
    () => revived.openAppeal({ appeal_id: "ap-x", entry_id: "entry-1", stage: "final", grounds: "x" }),
    (err) => err.code === "CASE_SEALED",
  );

  // 中断前的状态在重建后完整可见
  const explain = revived.explainCandidate("entry-1");
  assert.equal(explain.sealed, true);
  assert.equal(explain.final_status, "advanced");
});
