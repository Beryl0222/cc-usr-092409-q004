import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import { createSealingService } from "../src/service.js";

/** 可控时钟 + 顺序 ID 的测试服务；delivered 记录所有真实外发通知。 */
export function makeHarness({ fileBacked = false, deliver = null } = {}) {
  let counter = 0;
  const state = {
    clock: "2026-09-01T09:00:00+08:00",
    delivered: [],
    dir: null,
  };
  if (fileBacked) {
    state.dir = mkdtempSync(join(tmpdir(), "seal-"));
    after(() => rmSync(state.dir, { recursive: true, force: true }));
  }
  const newId = (prefix = "id") => `${prefix}-${String(++counter).padStart(4, "0")}`;
  const now = () => state.clock;
  const svc = createSealingService({
    eventLogPath: fileBacked ? join(state.dir, "events.jsonl") : null,
    now,
    newId,
    deliver: deliver ?? (async (message) => {
      state.delivered.push({ subject: message.subject, dedupKey: message.dedupKey });
    }),
  });
  return {
    svc,
    workflow: svc.workflow,
    queries: svc.queries,
    store: svc.store,
    tick(at) {
      state.clock = at;
    },
    get delivered() {
      return state.delivered;
    },
    dir: state.dir,
  };
}

/** 登记量表、候选人并生成某阶段评审包、分配评委、提交评分、封卷的一体化夹具。 */
export function buildSealedPacket(h, {
  packetId = "P1",
  candidateId = "C1",
  stage = "prelim",
  reviewers = [
    { id: "R1", values: { depth: 8, clarity: 9 } },
    { id: "R2", values: { depth: 6, clarity: 7 } },
  ],
  qualVersion = 1,
} = {}) {
  const w = h.workflow;
  try {
    w.registerScale({ scaleId: "std", version: 1, rubric: { dimensions: ["depth", "clarity"] } });
  } catch (err) {
    if (err.code !== "CONFLICT") throw err;
  }
  try {
    w.acceptEntry({
      entryId: candidateId,
      candidateId,
      qualification: { works: ["w1"], credentials: ["c1"], id_number: "SECRET" },
      materials: [
        { material_id: "m1", type: "article", hash: "h1" },
        { material_id: "m2", type: "id_card", identifying: true },
      ],
    });
  } catch (err) {
    if (err.code !== "VERSION_CONFLICT") throw err;
  }
  w.generateReviewPacket({
    entryId: candidateId, packetId, stage, qualVersion, scaleId: "std", scaleVersion: 1,
  });
  const sheets = [];
  reviewers.forEach((r, i) => {
    w.assignReviewer({ packetId, reviewerId: r.id });
    const sheetId = r.sheetId ?? `S-${packetId}-${r.id}`;
    w.submitScore({
      sheetId, packetId, reviewerId: r.id,
      values: r.values, evidenceHashes: r.evidenceHashes ?? [`ev-${r.id}`],
    });
    sheets.push(sheetId);
  });
  const seal = w.sealPacket({ packetId });
  return { sheets, seal };
}
