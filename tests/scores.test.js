import assert from "node:assert/strict";
import test from "node:test";

import { makeHarness } from "./helpers.js";
import { canonicalHash } from "../src/hashing.js";
import { ErrorCode } from "../src/errors.js";

function setup(h) {
  const w = h.workflow;
  w.registerScale({ scaleId: "std", version: 1, rubric: { dimensions: ["depth"] } });
  w.acceptEntry({ entryId: "C1", candidateId: "C1", qualification: { works: ["w"] }, materials: [] });
  w.generateReviewPacket({ entryId: "C1", packetId: "P1", stage: "prelim", qualVersion: 1, scaleId: "std", scaleVersion: 1 });
  w.assignReviewer({ packetId: "P1", reviewerId: "R1" });
  w.assignReviewer({ packetId: "P1", reviewerId: "R2" });
}

test("评分提交锁定量表版本与评分细则哈希、证据指纹", () => {
  const h = makeHarness();
  setup(h);
  h.workflow.submitScore({
    sheetId: "S1", packetId: "P1", reviewerId: "R1",
    values: { depth: 8 }, evidenceHashes: ["ev-1", "ev-2"],
  });
  const event = h.store.readStream("score_sheet", "S1")[0];
  assert.equal(event.payload.scale_version_id, "std@1");
  assert.equal(event.payload.rubric_hash, canonicalHash({ dimensions: ["depth"] }));
  assert.deepEqual(event.payload.evidence_hashes.sort(), ["ev-1", "ev-2"]);
  assert.ok(event.payload.content_hash);

  // 量表事后改版不影响已提交评分
  h.workflow.registerScale({ scaleId: "std", version: 2, rubric: { dimensions: ["depth", "novelty"] } });
  h.workflow.submitScore({
    sheetId: "S2", packetId: "P1", reviewerId: "R2",
    values: { depth: 7 }, evidenceHashes: [],
  });
  assert.equal(h.store.readStream("score_sheet", "S2")[0].payload.scale_version_id, "std@1");
});

test("完全相同的重传沿用原结果，不产生新事件", () => {
  const h = makeHarness();
  setup(h);
  const payload = { sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { depth: 8 }, evidenceHashes: ["ev"] };
  const first = h.workflow.submitScore(payload);
  const eventCount = h.store.readAll().length;
  h.tick("2026-09-02T00:00:00+08:00");
  const again = h.workflow.submitScore(payload);
  assert.equal(again.duplicated, true);
  assert.equal(again.investigation, null);
  assert.equal(h.store.readAll().length, eventCount, "重传不追加事件");
  assert.equal(first.contentHash, again.duplicated ? first.contentHash : null);
});

test("同编号异内容进入调查并隔离；裁决驳回后排除、采信后恢复", () => {
  const h = makeHarness();
  setup(h);
  h.workflow.submitScore({ sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { depth: 5 }, evidenceHashes: ["ev-a"] });
  h.workflow.submitScore({ sheetId: "S2", packetId: "P1", reviewerId: "R2", values: { depth: 5 }, evidenceHashes: ["ev-b"] });

  h.tick("2026-09-02T00:00:00+08:00");
  const conflict = h.workflow.submitScore({
    sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { depth: 10 }, evidenceHashes: ["ev-z"],
  });
  assert.ok(conflict.investigation, "应返回调查案号");
  const opened = h.store.readStream("score_sheet", "S1").find((e) => e.event_type === "SCORE_INVESTIGATION_OPENED");
  assert.ok(opened);
  assert.notEqual(opened.payload.original_content_hash, opened.payload.received_content_hash);

  // 调查期间评分隔离，不能封卷
  assert.throws(() => h.workflow.sealPacket({ packetId: "P1" }), /不能封卷|未提交有效评分/);

  h.workflow.resolveScoreInvestigation({ sheetId: "S1", outcome: "reject", note: "无法说明来源", complianceOfficerId: "CO1" });
  const accounting = h.queries.packetAccounting("P1");
  assert.deepEqual(accounting.excluded.map((x) => [x.sheet_id, x.reason]), [["S1", "investigation_rejected"]]);

  // R2 仍不足法定人数以外的场景：只有一份有效分也可封卷（有效集非空且轮次齐全）
  const seal = h.workflow.sealPacket({ packetId: "P1" });
  assert.deepEqual(seal.effective, ["S2"]);
});

test("调查裁决采信重传后评分恢复有效", () => {
  const h = makeHarness();
  setup(h);
  h.workflow.submitScore({ sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { depth: 5 }, evidenceHashes: [] });
  h.workflow.submitScore({ sheetId: "S2", packetId: "P1", reviewerId: "R2", values: { depth: 5 }, evidenceHashes: [] });
  h.workflow.submitScore({ sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { depth: 6 }, evidenceHashes: [] });
  h.workflow.resolveScoreInvestigation({ sheetId: "S1", outcome: "accept", note: "系补正笔误", complianceOfficerId: "CO1" });
  assert.deepEqual(h.queries.packetAccounting("P1").effective.map((s) => s.sheet_id).sort(), ["S1", "S2"]);
});

test("已封卷后拒绝新评分", () => {
  const h = makeHarness();
  setup(h);
  h.workflow.submitScore({ sheetId: "S1", packetId: "P1", reviewerId: "R1", values: { depth: 8 }, evidenceHashes: [] });
  h.workflow.submitScore({ sheetId: "S2", packetId: "P1", reviewerId: "R2", values: { depth: 8 }, evidenceHashes: [] });
  h.workflow.sealPacket({ packetId: "P1" });
  assert.throws(
    () => h.workflow.submitScore({ sheetId: "S9", packetId: "P1", reviewerId: "R1", values: { depth: 9 }, evidenceHashes: [] }),
    (err) => err.code === ErrorCode.ALREADY_SEALED,
  );
});
