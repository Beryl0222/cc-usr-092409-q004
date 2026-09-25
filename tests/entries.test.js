import assert from "node:assert/strict";
import test from "node:test";

import { makeService, seedEntry } from "./helpers.js";

test("报名材料按资格版本生成脱敏评审包", async () => {
  const { service } = makeService();
  await seedEntry(service);

  const explain = service.explainCandidate("entry-1");
  assert.equal(explain.packages.length, 1);
  assert.equal(explain.packages[0].qualification_version, 1);
  assert.deepEqual(explain.packages[0].redacted_fields, ["contact", "identity"]);

  // 评委工作台只见脱敏内容
  const workspace = service.judgeWorkspace("judge-1", "entry-1");
  assert.deepEqual(Object.keys(workspace.review_package.content).sort(), ["awards", "work_samples"]);
});

test("资格版本变化生成新评审包，旧版本保留供审计", async () => {
  const { service } = makeService();
  await seedEntry(service);
  await service.reviseEntry({
    entry_id: "entry-1",
    qualification_version: 2,
    materials: {
      identity: { name: "张三" },
      work_samples: ["调查报道甲", "特写乙", "深度报道丁"],
      awards: ["年度新闻奖丙", "季度奖戊"],
    },
    at: "2026-09-10T09:00:00+08:00",
  });

  const explain = service.explainCandidate("entry-1");
  assert.equal(explain.qualification_version, 2);
  assert.equal(explain.packages.length, 2);
  assert.notEqual(explain.packages[0].package_hash, explain.packages[1].package_hash);

  // 当前评审使用资格版本 2 的评审包
  const workspace = service.judgeWorkspace("judge-1", "entry-1");
  assert.equal(workspace.review_package.qualification_version, 2);
  assert.equal(workspace.review_package.content.work_samples.length, 3);
  assert.equal(workspace.review_package.content.identity, undefined);
});
