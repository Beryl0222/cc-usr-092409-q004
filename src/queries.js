import { reduce, effectiveSheets } from "./projection.js";

/**
 * 只读查询：全部基于事件日志重放，保证解释口径与封卷口径完全一致。
 * 核心查询 explainCandidate 回答：
 *   一名候选人在每个阶段用了哪些有效评分、哪些评分被排除及原因、最终决定为何变化。
 */
export class Queries {
  constructor(store) {
    this.store = store;
  }

  state() {
    return reduce(this.store.readAll());
  }

  /** 候选人在选拔全过程的逐阶段可解释轨迹。 */
  explainCandidate(candidateId) {
    const state = this.state();
    const entry = state.entries.get(candidateId);
    const packets = [...state.packets.values()]
      .filter((packet) => packet.entryId === candidateId || packet.candidateId === candidateId)
      .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt) || a.stage.localeCompare(b.stage));

    const appeals = [...state.appeals.values()]
      .filter((appeal) => appeal.candidateId === candidateId)
      .sort((a, b) => a.filedAt.localeCompare(b.filedAt));

    return {
      candidate_id: candidateId,
      entry: entry ? { accepted_at: entry.acceptedAt, latest_qual_version: entry.latestVersion } : null,
      stages: packets.map((packet) => this.#explainPacket(state, packet)),
      appeals: appeals.map((appeal) => ({
        appeal_id: appeal.id,
        target_packet_id: appeal.targetPacketId,
        target_stage: appeal.targetStage,
        filed_at: appeal.filedAt,
        material_batches: appeal.materials.map((m) => ({
          batch_id: m.batchId,
          added_at: m.addedAt,
          item_count: m.items.length,
          note: m.note,
        })),
        signatures: Object.fromEntries(
          Object.entries(appeal.signatures).map(([role, sig]) => [
            role,
            { signer_id: sig.by, signed_at: sig.at, based_on_material_batches: sig.signedMaterialCount },
          ]),
        ),
        decision: appeal.decision
          ? {
              outcome: appeal.decision.outcome,
              action: appeal.decision.action,
              basis: appeal.decision.basis,
              decided_at: appeal.decidedAt,
              effects: appeal.decision.effects,
            }
          : null,
      })),
    };
  }

  #explainPacket(state, packet) {
    const { effective, excluded } = effectiveSheets(state, packet);
    const facts = [...state.facts.values()].filter((f) => f.candidateId === packet.entryId);

    // 决定时间线：封卷 → 公布 → 暂缓/复核/更正，严格按事件顺序，旧决定永不消失。
    const timeline = packet.decisions.map((decision) => {
      const base = {
        kind: decision.kind,
        at: decision.at,
        event_id: decision.eventId,
        summary: decision.summary,
      };
      if (decision.kind === "sealed" || decision.kind === "correction") {
        return {
          ...base,
          result: decision.result,
          effective_sheet_ids: decision.effectiveSheetIds,
          excluded_sheet_ids: decision.excludedSheetIds,
          effective_hash: decision.effectiveHash,
          ...(decision.kind === "correction"
            ? { previous_result: decision.payload?.previous_result ?? null, reason: decision.reason, ref_id: decision.refId }
            : {}),
        };
      }
      if (decision.kind === "published") {
        return { ...base, list_id: decision.listId, rank: decision.rank, list_result: decision.result };
      }
      return { ...base, reason: decision.reason, ref_id: decision.refId };
    });

    return {
      stage: packet.stage,
      packet_id: packet.id,
      packet_generated_at: packet.generatedAt,
      qual_version: packet.qualVersion,
      scale_version: packet.scaleVersionId,
      snapshot_hash: packet.snapshotHash,
      visible_fields: packet.visibleFields,
      exposed_materials: packet.exposedMaterials,
      sealed: packet.sealedAt !== null,
      sealed_at: packet.sealedAt,
      status: packet.rescoreStatus ?? (packet.sealedAt ? "final" : "in_review"),
      assignments: packet.assignments.map((a) => ({
        reviewer_id: a.reviewerId,
        role: a.role,
        round: a.round,
        status: a.status,
        assigned_at: a.assignedAt,
      })),
      conflict_flags: packet.flags.map((f) => ({
        reviewer_id: f.reviewerId,
        fact_id: f.factId,
        reason: f.reason,
        disposition: f.disposition,
        decided_at: f.decidedAt ?? null,
        compliance_officer_id: f.complianceOfficerId ?? null,
      })),
      relevant_recusal_facts: facts
        .filter((f) => packet.assignments.some((a) => a.reviewerId === f.reviewerId))
        .map((f) => ({
          fact_id: f.id,
          reviewer_id: f.reviewerId,
          kind: f.kind,
          valid_from: f.validFrom,
          valid_to: f.validTo,
          declared_at: f.declaredAt,
        })),
      effective_scores: effective.map((sheet) => ({
        sheet_id: sheet.id,
        reviewer_id: sheet.reviewerId,
        round: sheet.round,
        scale_version: sheet.scaleVersionId,
        rubric_hash: sheet.rubricHash,
        total: sheet.total,
        values: sheet.values,
        evidence_hashes: sheet.evidenceHashes,
        content_hash: sheet.contentHash,
        submitted_at: sheet.submittedAt,
      })),
      excluded_scores: excluded.map(({ sheet, reason }) => ({
        sheet_id: sheet.id,
        reviewer_id: sheet.reviewerId,
        round: sheet.round,
        total: sheet.total,
        submitted_at: sheet.submittedAt,
        excluded_reason: reason,
        excluded_at: sheet.excludedAt ?? null,
        ref: sheet.exclusionRef,
        investigation: sheet.investigation
          ? {
              case_ref: sheet.investigation.caseRef,
              opened_at: sheet.investigation.openedAt,
              outcome: sheet.investigation.outcome,
              resolved_at: sheet.investigation.resolvedAt,
            }
          : null,
      })),
      current_result: latestResult(packet),
      decision_timeline: timeline,
    };
  }

  /** 封卷口径快照：供封卷前预检/审计页面使用。 */
  packetAccounting(packetId) {
    const state = this.state();
    const packet = state.packets.get(packetId);
    if (!packet) return null;
    const { effective, excluded } = effectiveSheets(state, packet);
    return {
      packet_id: packetId,
      sealed: packet.sealedAt !== null,
      pending_conflict_flags: packet.flags.filter((f) => f.disposition === "pending").length,
      effective: effective.map((s) => ({ sheet_id: s.id, reviewer_id: s.reviewerId, round: s.round, total: s.total })),
      excluded: excluded.map(({ sheet, reason }) => ({ sheet_id: sheet.id, reviewer_id: sheet.reviewerId, reason })),
    };
  }

  pendingConflictFlags() {
    const state = this.state();
    const result = [];
    for (const packet of state.packets.values()) {
      for (const flag of packet.flags.filter((f) => f.disposition === "pending")) {
        result.push({ packet_id: packet.id, ...flag });
      }
    }
    return result;
  }
}

function latestResult(packet) {
  for (let i = packet.decisions.length - 1; i >= 0; i--) {
    const decision = packet.decisions[i];
    if (decision.kind === "correction") return { ...decision.result, as_of: decision.at, via: "correction" };
    if (decision.kind === "sealed") return { ...decision.result, as_of: decision.at, via: "sealed" };
  }
  return null;
}
