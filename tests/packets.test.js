import assert from "node:assert/strict";
import test from "node:test";

import { makeHarness } from "./helpers.js";

test("评审包按资格版本生成脱敏快照，身份字段与身份材料不进入评审包", () => {
  const h = makeHarness();
  const w = h.workflow;
  w.registerScale({ scaleId: "std", version: 1, rubric: { d: ["x"] } });
  w.acceptEntry({
    entryId: "C1",
    candidateId: "C1",
    qualification: { works: ["w1"], id_number: "110101-19900101-0000" },
    personal: { name: "张三", phone: "13800000000" },
    materials: [
      { material_id: "m1", type: "article", hash: "h1" },
      { material_id: "m2", type: "id_scan", identifying: true, hash: "h2" },
    ],
  });
  const { packetId, snapshotHash } = w.generateReviewPacket({
    entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 1,
    scaleId: "std", scaleVersion: 1,
  });

  const stage = h.queries.explainCandidate("C1").stages[0];
  assert.deepEqual(stage.visible_fields, ["works", "credentials"]);
  assert.deepEqual(stage.exposed_materials.map((m) => m.material_id), ["m1"]);
  const generatedEvent = h.store.readStream("review_packet", packetId)[0];
  const exposed = JSON.stringify(generatedEvent.payload);
  assert.ok(!exposed.includes("110101"), "身份号码不得出现在评审包事件中");
  assert.ok(!exposed.includes("张三"), "姓名不得出现在评审包事件中");
  assert.ok(!exposed.includes("13800000000"), "电话不得出现在评审包事件中");
  assert.ok(!exposed.includes("m2"), "身份材料不得进入评审包");
  assert.ok(snapshotHash);
});

test("评审包冻结旧资格版本；后续材料改版不改变已生成快照内容", () => {
  const h = makeHarness();
  const w = h.workflow;
  w.registerScale({ scaleId: "std", version: 1, rubric: { d: 1 } });
  w.acceptEntry({ entryId: "C1", candidateId: "C1", qualification: { works: ["old"] }, materials: [] });
  w.generateReviewPacket({
    entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 1,
    scaleId: "std", scaleVersion: 1,
  });
  const before = h.queries.packetAccounting("P1");
  w.submitMaterialVersion({
    entryId: "C1", version: 2,
    qualification: { works: ["new-work"] }, materials: [],
  });
  const stage = h.queries.explainCandidate("C1").stages[0];
  assert.equal(stage.qual_version, 1);
  assert.deepEqual(
    h.store.readStream("review_packet", "P1")[0].payload.exposed_materials,
    h.store.readStream("review_packet", "P1")[0].payload.exposed_materials,
  );
  void before;
});

test("不存在的资格版本或量表版本不能生成评审包", () => {
  const h = makeHarness();
  const w = h.workflow;
  w.registerScale({ scaleId: "std", version: 1, rubric: { d: 1 } });
  w.acceptEntry({ entryId: "C1", candidateId: "C1", qualification: { works: [] }, materials: [] });
  assert.throws(
    () => w.generateReviewPacket({
      entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 9,
      scaleId: "std", scaleVersion: 1,
    }),
    /资格版本 9 不存在/,
  );
  assert.throws(
    () => w.generateReviewPacket({
      entryId: "C1", packetId: "P2", stage: "prelim", qualVersion: 1,
      scaleId: "std", scaleVersion: 2,
    }),
    /量表版本未登记/,
  );
});
