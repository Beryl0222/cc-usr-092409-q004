import { canonicalHash } from "./hashing.js";

/**
 * 纯函数事件归约器：把全部领域事件折叠为当前状态。
 * 不做任何业务裁决（裁决在 workflow 层），只忠实记录事实，
 * 因此中断恢复只需重放事件日志即可重建全部案件与通知状态。
 */

export function reduce(events, initial = emptyState()) {
  const state = initial;
  for (const event of events) apply(state, event);
  return state;
}

export function emptyState() {
  return {
    entries: new Map(),
    scales: new Map(),
    packets: new Map(),
    sheets: new Map(),
    facts: new Map(),
    lists: new Map(),
    sealJobs: new Map(),
    appeals: new Map(),
    outbox: new Map(),
  };
}

function apply(state, event) {
  const p = event.payload ?? {};
  switch (event.event_type) {
    case "ENTRY_ACCEPTED": {
      state.entries.set(event.aggregate_id, {
        id: event.aggregate_id,
        candidateId: p.candidate_id ?? event.aggregate_id,
        acceptedAt: event.occurred_at,
        versions: new Map(),
        latestVersion: 0,
      });
      if (p.qualification || p.materials) {
        addVersion(state.entries.get(event.aggregate_id), 1, event);
      }
      break;
    }
    case "MATERIAL_VERSION_SUBMITTED": {
      const entry = must(state.entries, event.aggregate_id, event);
      addVersion(entry, p.version, event);
      break;
    }
    case "SCALE_VERSION_REGISTERED": {
      state.scales.set(scaleKey(p.scale_id, p.version), {
        scaleId: p.scale_id,
        version: p.version,
        rubricHash: p.rubric_hash,
        registeredAt: event.occurred_at,
      });
      break;
    }
    case "REVIEW_PACKET_GENERATED": {
      state.packets.set(p.packet_id, {
        id: p.packet_id,
        entryId: p.entry_id ?? p.candidate_id,
        candidateId: p.candidate_id,
        stage: p.stage,
        qualVersion: p.qual_version,
        scaleId: p.scale_id,
        scaleVersion: p.scale_version,
        scaleVersionId: `${p.scale_id}@${p.scale_version}`,
        token: p.review_token,
        snapshotHash: p.snapshot_hash,
        visibleFields: p.visible_fields ?? [],
        exposedMaterials: p.exposed_materials ?? [],
        generatedAt: event.occurred_at,
        assignments: [],
        flags: [],
        rounds: [{ round: 1, openedAt: event.occurred_at, kind: "regular" }],
        supplementalRounds: [],
        sealedAt: null,
        sealedResult: null,
        rescoreStatus: null,
        decisions: [],
      });
      break;
    }
    case "REVIEWER_ASSIGNED": {
      const packet = must(state.packets, event.aggregate_id, event);
      packet.assignments.push({
        assignmentId: p.assignment_id,
        reviewerId: p.reviewer_id,
        role: p.role,
        round: p.round ?? 1,
        status: "assigned",
        assignedAt: event.occurred_at,
      });
      break;
    }
    case "CONFLICT_FLAGGED": {
      const packet = must(state.packets, event.aggregate_id, event);
      packet.flags.push({
        flagId: p.flag_id,
        assignmentId: p.assignment_id,
        reviewerId: p.reviewer_id,
        factId: p.fact_id,
        reason: p.reason,
        flaggedAt: event.occurred_at,
        disposition: "pending",
      });
      break;
    }
    case "CONFLICT_CONFIRMED":
    case "CONFLICT_DISMISSED": {
      const packet = must(state.packets, event.aggregate_id, event);
      const flag = packet.flags.find((f) => f.flagId === p.flag_id);
      if (flag) {
        flag.disposition = event.event_type === "CONFLICT_CONFIRMED" ? "confirmed" : "dismissed";
        flag.decidedAt = event.occurred_at;
        flag.complianceOfficerId = p.compliance_officer_id;
        flag.note = p.note;
      }
      const assignment = packet.assignments.find((a) => a.assignmentId === p.assignment_id);
      if (assignment && event.event_type === "CONFLICT_CONFIRMED") assignment.status = "recused";
      if (assignment && event.event_type === "CONFLICT_DISMISSED") assignment.status = "cleared";
      break;
    }
    case "REVIEWER_RECUSED": {
      const packet = must(state.packets, event.aggregate_id, event);
      for (const assignment of packet.assignments) {
        const matchesAssignment = assignment.assignmentId === p.assignment_id
          || (p.assignment_id == null && assignment.reviewerId === p.reviewer_id);
        if (matchesAssignment) {
          assignment.status = "recused";
          assignment.recusedAt = event.occurred_at;
          assignment.recusalFactId = p.fact_id ?? assignment.recusalFactId ?? null;
        }
      }
      break;
    }
    case "AFFECTED_SCORE_ISOLATED": {
      // 隔离决定记录在封卷包上；评分表自身状态由 SCORE_EXCLUDED 表达。
      const packet = must(state.packets, event.aggregate_id, event);
      packet.isolated = packet.isolated ?? [];
      packet.isolated.push({
        sheetId: p.sheet_id,
        reviewerId: p.reviewer_id,
        factId: p.fact_id ?? null,
        reason: p.reason,
        isolatedAt: event.occurred_at,
      });
      break;
    }
    case "SUPPLEMENTAL_ROUND_OPENED": {
      const packet = must(state.packets, event.aggregate_id, event);
      packet.supplementalRounds.push({
        round: p.round,
        reason: p.reason,
        refId: p.ref_id ?? null,
        openedAt: event.occurred_at,
      });
      break;
    }
    case "SCORE_SUBMITTED": {
      const existing = state.sheets.get(event.aggregate_id);
      if (existing) {
        existing.retransmitCount = (existing.retransmitCount ?? 0) + 1;
        break; // 完全相同的重传：沿用原结果，不改变任何状态
      }
      const sheet = {
        id: event.aggregate_id,
        packetId: p.packet_id,
        stage: p.stage,
        reviewerId: p.reviewer_id,
        round: p.round ?? 1,
        scaleVersionId: p.scale_version_id,
        rubricHash: p.rubric_hash,
        values: p.values ?? null,
        evidenceHashes: p.evidence_hashes ?? [],
        valuesHash: p.values_hash,
        contentHash: p.content_hash,
        total: p.total,
        submittedAt: event.occurred_at,
        status: "effective",
        exclusionReason: null,
        retransmitCount: 0,
        investigation: null,
      };
      state.sheets.set(sheet.id, sheet);
      break;
    }
    case "SCORE_EXCLUDED": {
      const sheet = must(state.sheets, event.aggregate_id, event);
      sheet.status = "excluded";
      sheet.exclusionReason = p.reason;
      sheet.excludedAt = event.occurred_at;
      sheet.exclusionRef = p.fact_id ?? p.case_ref ?? null;
      break;
    }
    case "SCORE_INVESTIGATION_OPENED": {
      const sheet = must(state.sheets, event.aggregate_id, event);
      sheet.status = "quarantined";
      sheet.investigation = {
        caseRef: p.case_ref,
        reason: p.reason,
        openedAt: event.occurred_at,
        receivedContentHash: p.received_content_hash ?? null,
        resolvedAt: null,
        outcome: null,
      };
      break;
    }
    case "SCORE_INVESTIGATION_RESOLVED": {
      const sheet = must(state.sheets, event.aggregate_id, event);
      if (sheet.investigation) {
        sheet.investigation.resolvedAt = event.occurred_at;
        sheet.investigation.outcome = p.outcome; // accept | reject
        sheet.investigation.note = p.note;
      }
      sheet.status = p.outcome === "accept" ? "effective" : "excluded";
      if (p.outcome !== "accept") {
        sheet.exclusionReason = "investigation_rejected";
        sheet.excludedAt = event.occurred_at;
      } else {
        sheet.exclusionReason = null;
      }
      break;
    }
    case "PACKET_SEALED": {
      const packet = must(state.packets, event.aggregate_id, event);
      packet.sealedAt = event.occurred_at;
      packet.sealedResult = p.result;
      packet.decisions.push({
        kind: "sealed",
        at: event.occurred_at,
        eventId: event.event_id,
        summary: event.summary,
        result: p.result,
        effectiveSheetIds: p.effective_sheet_ids,
        excludedSheetIds: p.excluded_sheet_ids,
        effectiveHash: p.effective_hash,
      });
      break;
    }
    case "HOLD_PLACED":
    case "REVIEW_ADDED":
    case "CORRECTION_ISSUED": {
      const packet = must(state.packets, event.aggregate_id, event);
      if (event.event_type === "REVIEW_ADDED") packet.rescoreStatus = p.status ?? "pending_rescore";
      if (event.event_type === "HOLD_PLACED") packet.rescoreStatus = "held";
      if (event.event_type === "CORRECTION_ISSUED") packet.rescoreStatus = "corrected";
      packet.decisions.push({
        kind: event.event_type === "HOLD_PLACED" ? "hold"
          : event.event_type === "REVIEW_ADDED" ? "review" : "correction",
        at: event.occurred_at,
        eventId: event.event_id,
        summary: event.summary,
        reason: p.reason,
        refId: p.ref_id ?? null,
        result: p.result ?? null,
        effectiveSheetIds: p.effective_sheet_ids ?? null,
        effectiveHash: p.effective_hash ?? null,
        payload: p,
      });
      break;
    }
    case "LIST_PUBLISHED": {
      const list = {
        id: event.aggregate_id,
        stage: p.stage,
        entries: p.entries,
        publishedAt: event.occurred_at,
      };
      state.lists.set(list.id, list);
      for (const item of p.entries) {
        const packet = state.packets.get(item.packet_id);
        if (packet) {
          packet.decisions.push({
            kind: "published",
            at: event.occurred_at,
            eventId: event.event_id,
            summary: `阶段 ${p.stage} 名单公布：${item.result}（名次 ${item.rank}）`,
            listId: list.id,
            rank: item.rank,
            result: item.result,
          });
        }
      }
      break;
    }
    case "SEAL_JOB_REQUESTED": {
      state.sealJobs.set(event.aggregate_id, {
        id: event.aggregate_id,
        packetId: p.packet_id,
        requestedAt: event.occurred_at,
        completedAt: null,
      });
      break;
    }
    case "SEAL_JOB_COMPLETED": {
      const job = state.sealJobs.get(event.aggregate_id);
      if (job) job.completedAt = event.occurred_at;
      break;
    }
    case "RECUSAL_FACT_DECLARED": {
      state.facts.set(p.fact_id, {
        id: p.fact_id,
        reviewerId: p.reviewer_id,
        candidateId: p.candidate_id,
        kind: p.kind,
        detail: p.detail ?? "",
        validFrom: p.valid_from,
        validTo: p.valid_to,
        declaredAt: event.occurred_at,
      });
      break;
    }
    case "APPEAL_FILED": {
      state.appeals.set(p.appeal_id, {
        id: p.appeal_id,
        candidateId: p.candidate_id,
        targetPacketId: p.target_packet_id,
        targetStage: p.target_stage,
        reason: p.reason,
        filedAt: event.occurred_at,
        materials: [],
        signatures: {},
        decidedAt: null,
        decision: null,
      });
      break;
    }
    case "APPEAL_MATERIAL_ADDED": {
      const appeal = must(state.appeals, event.aggregate_id, event);
      appeal.materials.push({
        batchId: p.batch_id,
        addedAt: event.occurred_at,
        note: p.note ?? "",
        items: p.items ?? [],
      });
      break;
    }
    case "APPEAL_SIGNED": {
      const appeal = must(state.appeals, event.aggregate_id, event);
      appeal.signatures[p.role] = {
        by: p.signer_id,
        at: event.occurred_at,
        signedMaterialCount: p.signed_material_count ?? appeal.materials.length,
      };
      break;
    }
    case "APPEAL_DECIDED": {
      const appeal = must(state.appeals, event.aggregate_id, event);
      appeal.decidedAt = event.occurred_at;
      appeal.decision = {
        outcome: p.outcome,
        action: p.action,
        basis: p.basis,
        materialHashes: p.material_hashes,
        effects: p.effects ?? [],
      };
      break;
    }
    case "OUTBOX_ENQUEUED": {
      if (!state.outbox.has(event.aggregate_id)) {
        state.outbox.set(event.aggregate_id, {
          id: event.aggregate_id,
          dedupKey: p.dedup_key,
          channel: p.channel,
          recipient: p.recipient,
          subject: p.subject,
          body: p.body,
          ref: p.ref ?? {},
          createdAt: event.occurred_at,
          deliveredAt: null,
          attempts: 0,
        });
      }
      break;
    }
    case "OUTBOX_DELIVERED": {
      const message = state.outbox.get(event.aggregate_id);
      if (message) {
        message.deliveredAt = event.occurred_at;
        message.attempts += 1;
      }
      break;
    }
    default:
      // 未知事件类型保留在日志中，归约器不阻断重放。
      break;
  }
}

function addVersion(entry, version, event) {
  const p = event.payload ?? {};
  entry.versions.set(version, {
    version,
    submittedAt: event.occurred_at,
    qualification: p.qualification ?? {},
    personal: p.personal ?? {},
    materials: p.materials ?? [],
    hash: p.version_hash ?? canonicalHash({ qualification: p.qualification ?? {}, materials: p.materials ?? [] }),
  });
  entry.latestVersion = Math.max(entry.latestVersion, version);
}

function must(map, id, event) {
  const value = map.get(id);
  if (!value) throw new Error(`归约失败：事件 ${event.event_type} 引用了不存在的聚合 ${id}`);
  return value;
}

export function scaleKey(scaleId, version) {
  return `${scaleId}@${version}`;
}

/** 事实在某时刻是否生效（闭区间）。 */
export function factActiveAt(fact, at) {
  return (!fact.validFrom || fact.validFrom <= at) && (!fact.validTo || at <= fact.validTo);
}

/** 事实生效区间与 [from, to] 是否重叠。 */
export function factOverlaps(fact, from, to) {
  const left = fact.validFrom ?? "0000-01-01T00:00:00Z";
  const right = fact.validTo ?? "9999-12-31T23:59:59Z";
  return left <= to && from <= right;
}

/** 计算封卷包当前的有效/隔离评分集合（任何决策点都用同一口径）。 */
export function effectiveSheets(state, packet) {
  const activeReviewerRounds = new Map();
  for (const a of packet.assignments) {
    if (a.status === "recused") continue;
    activeReviewerRounds.set(a.reviewerId, a.round);
  }
  const effective = [];
  const excluded = [];
  for (const sheet of state.sheets.values()) {
    if (sheet.packetId !== packet.id) continue;
    if (sheet.status === "effective") {
      const activeRound = activeReviewerRounds.get(sheet.reviewerId);
      // 被隔离评委旧轮次的分数即使状态未翻转为 excluded，也不计入（双保险口径）。
      const assignment = packet.assignments.find((a) => a.reviewerId === sheet.reviewerId);
      if (assignment?.status === "recused") {
        excluded.push({ sheet, reason: sheet.exclusionReason ?? "reviewer_recused" });
        continue;
      }
      if (activeRound !== undefined && sheet.round < activeRound) {
        excluded.push({ sheet, reason: "superseded_round" });
        continue;
      }
      effective.push(sheet);
    } else {
      excluded.push({ sheet, reason: sheet.exclusionReason ?? sheet.status });
    }
  }
  effective.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id));
  excluded.sort((a, b) => a.sheet.submittedAt.localeCompare(b.sheet.submittedAt) || a.sheet.id.localeCompare(b.sheet.id));
  return { effective, excluded };
}

export function effectiveHash(effective) {
  return canonicalHash(
    effective.map((s) => ({ sheet: s.id, content: s.contentHash, total: s.total })),
  );
}

export function aggregateResult(effective) {
  if (effective.length === 0) return null;
  const total = effective.reduce((sum, s) => sum + (Number(s.total) || 0), 0) / effective.length;
  return { method: "average", average: Number(total.toFixed(4)), score_count: effective.length };
}
