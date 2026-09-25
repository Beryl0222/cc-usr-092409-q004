import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { AGGREGATE_TYPES, EVENT_TYPES } from "../src/vocabulary.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("样例流程中的每条事件都符合领域约定", async () => {
  const flow = JSON.parse(await readFile(new URL("../data/sample-flow.json", import.meta.url), "utf8"));
  for (const event of flow) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 不符合约定`);
  }
});

test("词汇表与契约 schema 的枚举保持一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(new Set(schema.properties.event_type.enum), new Set(EVENT_TYPES));
  assert.deepEqual(new Set(schema.properties.aggregate_type.enum), new Set(AGGREGATE_TYPES));
});
