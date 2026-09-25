import assert from "node:assert/strict";
import test from "node:test";

import { makeService, seedEntry } from "./helpers.js";

test("已公布名单不能重写，只能追加决定", async () => {
  const { service } = makeService();
  await seedEntry(service);
  await service.publishStageList({ stage: "final", advanced_entry_ids: ["entry-1"], at: "2026-09-15T10:00:00+08:00" });

  await assert.rejects(
    () => service.publishStageList({ stage: "final", advanced_entry_ids: [], at: "2026-09-16T10:00:00+08:00" }),
    (err) => err.code === "STAGE_ALREADY_PUBLISHED",
  );
  // 名单本身保持原样
  assert.deepEqual([...service.getStageList("final").advanced], ["entry-1"]);
});

test("追加暂缓、复核、更正依次改变有效状态并保留完整轨迹", async () => {
  const { service } = makeService();
  await seedEntry(service);
  await service.publishStageList({ stage: "final", advanced_entry_ids: ["entry-1"], at: "2026-09-15T10:00:00+08:00" });

  await service.appendDecision({ stage: "final", entry_id: "entry-1", kind: "hold", rationale: "回避确认，暂缓晋级", at: "2026-09-16T09:00:00+08:00" });
  await service.appendDecision({ stage: "final", entry_id: "entry-1", kind: "review", rationale: "替补评分完成，进入复核", at: "2026-09-17T09:00:00+08:00" });
  await service.appendDecision({ stage: "final", entry_id: "entry-1", kind: "correction", corrected_to: "advanced", rationale: "复核确认晋级有效", at: "2026-09-18T09:00:00+08:00" });

  const explain = service.explainCandidate("entry-1");
  const stage = explain.stages.find((s) => s.stage === "final");
  assert.equal(stage.base_status, "advanced");
  assert.equal(stage.effective_status, "advanced");
  assert.deepEqual(
    stage.status_trail.map((t) => [t.via, t.status]),
    [
      ["published_list", "advanced"],
      ["hold", "held"],
      ["review", "under_review"],
      ["correction", "advanced"],
    ],
  );
  // 每一步都带理由，能解释最终决定为何变化
  assert.equal(stage.status_trail[1].rationale, "回避确认，暂缓晋级");
  assert.equal(stage.decisions.length, 3);
});

test("未公布阶段不能追加决定，更正必须给出 corrected_to", async () => {
  const { service } = makeService();
  await seedEntry(service);
  await assert.rejects(
    () => service.appendDecision({ stage: "final", entry_id: "entry-1", kind: "hold", rationale: "x" }),
    (err) => err.code === "STAGE_NOT_PUBLISHED",
  );
  await service.publishStageList({ stage: "final", advanced_entry_ids: ["entry-1"], at: "2026-09-15T10:00:00+08:00" });
  await assert.rejects(
    () => service.appendDecision({ stage: "final", entry_id: "entry-1", kind: "correction", rationale: "x" }),
    (err) => err.code === "CORRECTED_TO_REQUIRED",
  );
});
