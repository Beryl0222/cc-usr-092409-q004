import assert from "node:assert/strict";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { makeService, seedEntry } from "./helpers.js";

test("服务产生的全部事件符合基础信封约定，且各聚合版本连续", async () => {
  const { store, service } = makeService();
  await seedEntry(service);
  await service.reviseEntry({
    entry_id: "entry-1",
    qualification_version: 2,
    materials: { work_samples: ["新稿"] },
    at: "2026-09-02T09:00:00+08:00",
  });
  await service.proposeAssignment({ assignment_id: "a1", entry_id: "entry-1", judge_id: "judge-1", stage: "final", at: "2026-09-03T09:00:00+08:00" });
  await service.submitScore({ sheet_id: "s1", assignment_id: "a1", rubric_version: "rv-1", criteria: [{ name: "写作", score: 80 }], evidence_refs: [], at: "2026-09-04T09:00:00+08:00" });
  // 幂等重传
  await service.submitScore({ sheet_id: "s1", assignment_id: "a1", rubric_version: "rv-1", criteria: [{ name: "写作", score: 80 }], evidence_refs: [], at: "2026-09-04T09:05:00+08:00" });
  await service.publishStageList({ stage: "final", advanced_entry_ids: ["entry-1"], at: "2026-09-05T09:00:00+08:00" });
  await service.sealCase({ entry_id: "entry-1", at: "2026-09-06T09:00:00+08:00" });
  await service.flushNotifications({ at: "2026-09-06T10:00:00+08:00" });

  const events = store.all();
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 不符合约定`);
  }

  // 每个聚合的版本从 1 开始连续递增（事件未被改写或丢失）
  const byAggregate = new Map();
  for (const event of events) {
    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    byAggregate.set(key, [...(byAggregate.get(key) ?? []), event.version]);
  }
  for (const [key, versions] of byAggregate) {
    assert.deepEqual(versions, versions.map((_, i) => i + 1), `聚合 ${key} 版本不连续`);
  }
});
