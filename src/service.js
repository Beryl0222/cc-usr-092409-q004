import { DomainError, canonicalHash, inInterval, redactMaterials } from "./domain.js";
import { APPEAL_OUTCOMES, DECISION_KINDS, RELATION_TYPES, SIGNOFF_ROLES } from "./vocabulary.js";

/**
 * 盲评封卷领域服务（事件溯源）。
 *
 * 设计要点：
 * - 一切状态变化先追加事件、再折叠进内存状态；服务崩溃后在同一事件库上
 *   重建即可恢复到一致状态（见文件底部对 store.all() 的重放）。
 * - 评分表状态机：locked（已锁定、有效）→ quarantined（回避隔离，保留审计）
 *   或 under_investigation（同编号异内容调查中，原结果继续有效）。
 * - 已公布的阶段名单不可改写，只能追加暂缓/复核/更正决定。
 * - 封卷是乐观并发控制的写操作，并发封卷只有一笔成功。
 *
 * @param {{ store: ReturnType<import("./eventStore.js").createEventStore>,
 *           now?: () => string,
 *           complianceOfficers?: string[] }} deps
 *   complianceOfficers：独立合规人员名单；非空时冲突确认必须由名单内、
 *   且非当事评委的人员签署。
 */
export function createReviewService({ store, now = () => new Date().toISOString(), complianceOfficers = [] } = {}) {
  if (!store) throw new DomainError("STORE_REQUIRED", "必须提供事件库");

  const state = {
    entries: new Map(), // entry_id -> { candidate_ref, qualification_version, materials, packages: Map }
    recusals: new Map(), // recusal_id -> { judge_id, candidate_ref, relation_type, valid_from, valid_to }
    assignments: new Map(), // assignment_id -> { entry_id, judge_id, stage, status, replaced_by }
    conflicts: new Map(), // conflict_id -> { assignment_id, recusal_id, status, resolution? }
    sheets: new Map(), // sheet_id -> { assignment_id, entry_id, judge_id, stage, status, versions: [] }
    investigations: new Map(), // sheet_id -> { status, attempted, ... }
    stageLists: new Map(), // stage -> { published_at, advanced: Set<entry_id> }
    decisions: [], // 追加决定（按事件顺序）
    appeals: new Map(), // appeal_id -> { entry_id, stage, status, batches: Map, signoffs, ruling }
    cases: new Map(), // entry_id -> { sealed, sealed_at, final_status }
    notifications: new Map(), // notif_id -> { entry_id, kind, status }
  };

  // ---------- 事件折叠：运行与重建共用 ----------

  function apply(event) {
    switch (event.event_type) {
      case "ENTRY_ACCEPTED":
        state.entries.set(event.aggregate_id, {
          entry_id: event.aggregate_id,
          candidate_ref: event.candidate_ref,
          qualification_version: event.qualification_version,
          materials: event.materials,
          packages: new Map(),
          created_at: event.occurred_at,
        });
        break;
      case "ENTRY_REVISED": {
        const entry = state.entries.get(event.aggregate_id);
        entry.qualification_version = event.qualification_version;
        entry.materials = event.materials;
        break;
      }
      case "REVIEW_PACKAGE_GENERATED": {
        const entry = state.entries.get(event.aggregate_id);
        entry.packages.set(event.qualification_version, {
          package_id: event.package_id,
          qualification_version: event.qualification_version,
          redacted_fields: event.redacted_fields,
          package_hash: event.package_hash,
          content: event.package_content,
          generated_at: event.occurred_at,
        });
        break;
      }
      case "RECUSAL_DECLARED":
        state.recusals.set(event.aggregate_id, {
          recusal_id: event.aggregate_id,
          judge_id: event.judge_id,
          candidate_ref: event.candidate_ref,
          relation_type: event.relation_type,
          valid_from: event.valid_from,
          valid_to: event.valid_to,
          declared_at: event.occurred_at,
        });
        break;
      case "ASSIGNMENT_PROPOSED":
        state.assignments.set(event.aggregate_id, {
          assignment_id: event.aggregate_id,
          entry_id: event.entry_id,
          judge_id: event.judge_id,
          stage: event.stage,
          status: "proposed",
          created_at: event.occurred_at,
          replaced_by: null,
        });
        break;
      case "ASSIGNMENT_ACTIVATED":
        state.assignments.get(event.aggregate_id).status = "active";
        break;
      case "CONFLICT_FLAGGED":
        state.conflicts.set(event.conflict_id, {
          conflict_id: event.conflict_id,
          assignment_id: event.aggregate_id,
          entry_id: event.entry_id,
          judge_id: event.judge_id,
          recusal_id: event.recusal_id,
          status: "flagged",
          flagged_at: event.occurred_at,
        });
        state.assignments.get(event.aggregate_id).status = "pending_compliance";
        break;
      case "CONFLICT_DISMISSED": {
        const conflict = state.conflicts.get(event.conflict_id);
        conflict.status = "dismissed";
        conflict.resolution = { confirmer_id: event.confirmer_id, rationale: event.rationale, at: event.occurred_at };
        break;
      }
      case "INCIDENT_CONFIRMED": {
        const conflict = state.conflicts.get(event.conflict_id);
        conflict.status = "confirmed";
        conflict.resolution = { confirmer_id: event.confirmer_id, rationale: event.rationale, at: event.occurred_at };
        state.assignments.get(event.aggregate_id).status = "recused";
        break;
      }
      case "ASSIGNMENT_REPLACED":
        state.assignments.get(event.aggregate_id).replaced_by = event.substitute_assignment_id;
        break;
      case "SCORE_SUBMITTED": {
        const version = {
          sheet_version: event.sheet_version,
          rubric_version: event.rubric_version,
          criteria: event.criteria,
          evidence_refs: event.evidence_refs,
          content_hash: event.content_hash,
          submitted_at: event.occurred_at,
        };
        const existing = state.sheets.get(event.aggregate_id);
        if (existing) {
          // 调查后接受的更正：作为后继版本追加，旧版本保留供审计
          existing.versions.push(version);
          existing.status = "locked";
        } else {
          state.sheets.set(event.aggregate_id, {
            sheet_id: event.aggregate_id,
            assignment_id: event.assignment_id,
            entry_id: event.entry_id,
            judge_id: event.judge_id,
            stage: event.stage,
            status: "locked",
            submitted_at: event.occurred_at,
            versions: [version],
            quarantine: null,
          });
        }
        break;
      }
      case "SCORE_RESUBMISSION_REUSED":
        break; // 完全相同的重传：仅留审计记录，结果沿用原表
      case "INVESTIGATION_OPENED": {
        state.sheets.get(event.aggregate_id).status = "under_investigation";
        state.investigations.set(event.aggregate_id, {
          sheet_id: event.aggregate_id,
          status: "open",
          opened_at: event.occurred_at,
          attempted: event.attempted_content,
          attempted_hash: event.attempted_hash,
        });
        break;
      }
      case "INVESTIGATION_RESOLVED": {
        const investigation = state.investigations.get(event.aggregate_id);
        investigation.status = "resolved";
        investigation.outcome = event.outcome;
        investigation.resolver_id = event.resolver_id;
        investigation.resolved_at = event.occurred_at;
        if (event.outcome === "keep_original") state.sheets.get(event.aggregate_id).status = "locked";
        // accept_correction 时由随后的 SCORE_SUBMITTED 新版本恢复 locked
        break;
      }
      case "SCORE_QUARANTINED": {
        const sheet = state.sheets.get(event.aggregate_id);
        sheet.status = "quarantined";
        sheet.quarantine = {
          conflict_id: event.conflict_id,
          recusal_id: event.recusal_id,
          reason: event.reason,
          at: event.occurred_at,
        };
        break;
      }
      case "STAGE_LIST_PUBLISHED":
        state.stageLists.set(event.aggregate_id, {
          stage: event.aggregate_id,
          published_at: event.occurred_at,
          advanced: new Set(event.advanced_entry_ids),
        });
        break;
      case "DECISION_APPENDED":
        state.decisions.push({
          stage: event.aggregate_id,
          entry_id: event.entry_id,
          kind: event.kind,
          corrected_to: event.corrected_to ?? null,
          rationale: event.rationale,
          source: event.source,
          appeal_id: event.appeal_id ?? null,
          at: event.occurred_at,
        });
        break;
      case "APPEAL_OPENED":
        state.appeals.set(event.aggregate_id, {
          appeal_id: event.aggregate_id,
          entry_id: event.entry_id,
          stage: event.stage,
          grounds: event.grounds,
          status: "open",
          opened_at: event.occurred_at,
          batches: new Map(),
          signoffs: {},
          ruling: null,
        });
        break;
      case "APPEAL_MATERIAL_RECEIVED":
        state.appeals.get(event.aggregate_id).batches.set(event.batch_id, event.batch_hash);
        break;
      case "APPEAL_SIGNOFF_RECORDED":
        state.appeals.get(event.aggregate_id).signoffs[event.role] = {
          signer_id: event.signer_id,
          outcome: event.outcome,
          note: event.note,
          at: event.occurred_at,
        };
        break;
      case "APPEAL_RULED": {
        const appeal = state.appeals.get(event.aggregate_id);
        appeal.status = "ruled";
        appeal.ruling = { outcome: event.outcome, corrected_to: event.corrected_to ?? null, at: event.occurred_at };
        break;
      }
      case "CASE_SEALED":
        state.cases.set(event.aggregate_id, {
          entry_id: event.aggregate_id,
          sealed: true,
          sealed_at: event.occurred_at,
          final_status: event.final_status,
        });
        break;
      case "DECISION_FINALIZED":
        state.cases.get(event.aggregate_id).final_status = event.final_status;
        break;
      case "NOTIFICATION_QUEUED":
        state.notifications.set(event.notif_id, {
          notif_id: event.notif_id,
          entry_id: event.aggregate_id,
          kind: event.kind,
          recipient: event.recipient,
          status: "queued",
          queued_at: event.occurred_at,
        });
        break;
      case "NOTIFICATION_SENT": {
        const notification = state.notifications.get(event.notif_id);
        notification.status = "sent";
        notification.sent_at = event.occurred_at;
        break;
      }
      default:
        throw new DomainError("UNKNOWN_EVENT", `无法折叠未知事件：${event.event_type}`);
    }
  }

  // 系统中断后恢复：在同一事件库上重放，重建一致状态
  for (const event of store.all()) apply(event);

  // ---------- 基础设施 ----------

  async function emit(eventType, aggregateType, aggregateId, summary, payload = {}, at) {
    const event = {
      event_id: `evt-${store.size() + 1}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: at ?? now(),
      version: store.versionOf(aggregateType, aggregateId) + 1,
      summary,
      ...payload,
    };
    const stored = await store.append(event);
    apply(stored);
    return stored;
  }

  function mustEntry(entryId) {
    const entry = state.entries.get(entryId);
    if (!entry) throw new DomainError("ENTRY_NOT_FOUND", `找不到报名记录：${entryId}`);
    return entry;
  }

  function mustAssignment(assignmentId) {
    const assignment = state.assignments.get(assignmentId);
    if (!assignment) throw new DomainError("ASSIGNMENT_NOT_FOUND", `找不到分配：${assignmentId}`);
    return assignment;
  }

  function mustAppeal(appealId) {
    const appeal = state.appeals.get(appealId);
    if (!appeal) throw new DomainError("APPEAL_NOT_FOUND", `找不到申诉：${appealId}`);
    return appeal;
  }

  function isSealed(entryId) {
    return state.cases.get(entryId)?.sealed === true;
  }

  function assertNotSealed(entryId) {
    if (isSealed(entryId)) throw new DomainError("CASE_SEALED", `案件 ${entryId} 已封卷，禁止再变更`);
  }

  // ---------- 报名与脱敏评审包 ----------

  async function generatePackage(entryId, qualificationVersion, materials, at) {
    const { content, redacted_fields } = redactMaterials(materials);
    await emit("REVIEW_PACKAGE_GENERATED", "candidate_entry", entryId, `生成资格版本 ${qualificationVersion} 的脱敏评审包`, {
      package_id: `pkg-${entryId}-q${qualificationVersion}`,
      qualification_version: qualificationVersion,
      redacted_fields,
      package_hash: canonicalHash(content),
      package_content: content,
    }, at);
  }

  async function acceptEntry({ entry_id, candidate_ref, qualification_version, materials, at }) {
    if (state.entries.has(entry_id)) throw new DomainError("ENTRY_EXISTS", `报名记录已存在：${entry_id}`);
    await emit("ENTRY_ACCEPTED", "candidate_entry", entry_id, `受理报名 ${entry_id}`, {
      candidate_ref,
      qualification_version,
      materials,
    }, at);
    await generatePackage(entry_id, qualification_version, materials, at);
    return { entry_id };
  }

  /** 资格版本变化：生成对应版本的新评审包，旧版本保留供审计。 */
  async function reviseEntry({ entry_id, qualification_version, materials, at }) {
    mustEntry(entry_id);
    assertNotSealed(entry_id);
    await emit("ENTRY_REVISED", "candidate_entry", entry_id, `报名材料修订至资格版本 ${qualification_version}`, {
      qualification_version,
      materials,
    }, at);
    await generatePackage(entry_id, qualification_version, materials, at);
    return { entry_id, qualification_version };
  }

  // ---------- 回避事实与冲突 ----------

  /**
   * 申报回避事实（任职/合作/指导，带生效区间）。
   * 迟报是常态：申报后立即回溯该评委与该候选人相关的既有分配，
   * 评分时间落在生效区间内的分配会被自动标记冲突，等待合规确认。
   */
  async function declareRecusal({ recusal_id, judge_id, candidate_ref, relation_type, valid_from, valid_to = null, at }) {
    if (!RELATION_TYPES.includes(relation_type)) {
      throw new DomainError("BAD_RELATION", `未知关系类型：${relation_type}`);
    }
    if (valid_to !== null && Date.parse(valid_to) < Date.parse(valid_from)) {
      throw new DomainError("BAD_INTERVAL", "生效区间终点早于起点");
    }
    await emit("RECUSAL_DECLARED", "recusal_fact", recusal_id, `申报回避：${judge_id} 与 ${candidate_ref} 的${relation_type}关系`, {
      judge_id,
      candidate_ref,
      relation_type,
      valid_from,
      valid_to,
    }, at);

    // 回溯既有分配：只标记评分时间落在生效区间内的
    for (const assignment of [...state.assignments.values()]) {
      if (assignment.judge_id !== judge_id || assignment.status === "recused") continue;
      const entry = state.entries.get(assignment.entry_id);
      if (!entry || entry.candidate_ref !== candidate_ref) continue;
      const sheetTimes = [...state.sheets.values()]
        .filter((sheet) => sheet.assignment_id === assignment.assignment_id)
        .map((sheet) => sheet.submitted_at);
      const affected = sheetTimes.length > 0
        ? sheetTimes.some((t) => inInterval(t, valid_from, valid_to))
        : inInterval(at ?? now(), valid_from, valid_to);
      if (affected) await flagConflict(assignment, recusal_id, at);
    }
    return { recusal_id };
  }

  async function flagConflict(assignment, recusalId, at) {
    // 同一（分配, 回避事实）只标记一次
    for (const conflict of state.conflicts.values()) {
      if (conflict.assignment_id === assignment.assignment_id && conflict.recusal_id === recusalId && conflict.status === "flagged") {
        return conflict.conflict_id;
      }
    }
    const conflictId = `conflict-${assignment.assignment_id}-${recusalId}`;
    await emit("CONFLICT_FLAGGED", "judging_assignment", assignment.assignment_id, `自动提示冲突：分配 ${assignment.assignment_id} 涉及回避事实 ${recusalId}`, {
      conflict_id: conflictId,
      entry_id: assignment.entry_id,
      judge_id: assignment.judge_id,
      recusal_id: recusalId,
    }, at);
    return conflictId;
  }

  /**
   * 独立合规人员确认冲突。
   * confirmed：分配转为已回避，并只隔离生效区间内的受影响评分（不删除，保留审计）。
   * dismissed：误报，分配恢复可用。
   */
  async function confirmConflict({ conflict_id, confirmer_id, decision, rationale, at }) {
    const conflict = state.conflicts.get(conflict_id);
    if (!conflict) throw new DomainError("CONFLICT_NOT_FOUND", `找不到冲突：${conflict_id}`);
    if (conflict.status !== "flagged") throw new DomainError("CONFLICT_ALREADY_RESOLVED", `冲突 ${conflict_id} 已处理`);
    const assignment = mustAssignment(conflict.assignment_id);
    if (complianceOfficers.length > 0 && !complianceOfficers.includes(confirmer_id)) {
      throw new DomainError("NOT_COMPLIANCE_OFFICER", `${confirmer_id} 不在独立合规人员名单内`);
    }
    if (confirmer_id === assignment.judge_id) {
      throw new DomainError("SELF_CONFIRMATION", "当事评委不得确认涉及自己的冲突");
    }

    if (decision === "dismissed") {
      await emit("CONFLICT_DISMISSED", "judging_assignment", assignment.assignment_id, `合规驳回冲突 ${conflict_id}`, {
        conflict_id, confirmer_id, rationale,
      }, at);
      if (assignment.status === "pending_compliance") {
        await emit("ASSIGNMENT_ACTIVATED", "judging_assignment", assignment.assignment_id, `冲突驳回，分配 ${assignment.assignment_id} 恢复可用`, {}, at);
      }
      return { conflict_id, decision };
    }
    if (decision !== "confirmed") throw new DomainError("BAD_DECISION", `未知确认结论：${decision}`);

    await emit("INCIDENT_CONFIRMED", "judging_assignment", assignment.assignment_id, `合规确认冲突 ${conflict_id}，分配回避`, {
      conflict_id, confirmer_id, rationale,
    }, at);

    // 只隔离受影响评分：该评委对该候选人、提交时间落在回避生效区间内的评分
    const recusal = state.recusals.get(conflict.recusal_id);
    const candidateRef = state.entries.get(assignment.entry_id)?.candidate_ref;
    for (const sheet of [...state.sheets.values()]) {
      if (sheet.judge_id !== assignment.judge_id || sheet.status !== "locked") continue;
      if (state.entries.get(sheet.entry_id)?.candidate_ref !== candidateRef) continue;
      if (!inInterval(sheet.submitted_at, recusal.valid_from, recusal.valid_to)) continue;
      if (isSealed(sheet.entry_id)) continue; // 已封卷案件不再变动，仅在审计中保留确认记录
      await emit("SCORE_QUARANTINED", "score_sheet", sheet.sheet_id, `回避隔离评分 ${sheet.sheet_id}`, {
        conflict_id,
        recusal_id: conflict.recusal_id,
        reason: "recusal_confirmed",
      }, at);
    }
    return { conflict_id, decision };
  }

  // ---------- 分配与替补 ----------

  /** 提议分配：先做冲突筛查，命中则挂起等待合规确认，否则直接激活。 */
  async function proposeAssignment({ assignment_id, entry_id, judge_id, stage, at }) {
    const entry = mustEntry(entry_id);
    assertNotSealed(entry_id);
    if (state.assignments.has(assignment_id)) throw new DomainError("ASSIGNMENT_EXISTS", `分配编号已存在：${assignment_id}`);
    for (const existing of state.assignments.values()) {
      if (existing.entry_id === entry_id && existing.judge_id === judge_id && existing.stage === stage
        && ["active", "pending_compliance"].includes(existing.status)) {
        throw new DomainError("ASSIGNMENT_DUPLICATE", `评委 ${judge_id} 在 ${stage} 已有该候选人的分配`);
      }
    }
    await emit("ASSIGNMENT_PROPOSED", "judging_assignment", assignment_id, `提议分配 ${judge_id} 评审 ${entry_id}（${stage}）`, {
      entry_id, judge_id, stage,
    }, at);
    const hit = [...state.recusals.values()].find(
      (recusal) => recusal.judge_id === judge_id
        && recusal.candidate_ref === entry.candidate_ref
        && inInterval(at ?? now(), recusal.valid_from, recusal.valid_to),
    );
    if (hit) {
      const conflictId = await flagConflict(state.assignments.get(assignment_id), hit.recusal_id, at);
      return { assignment_id, status: "pending_compliance", conflict_id: conflictId };
    }
    await emit("ASSIGNMENT_ACTIVATED", "judging_assignment", assignment_id, `分配 ${assignment_id} 生效`, {}, at);
    return { assignment_id, status: "active" };
  }

  /**
   * 替补评委：仅可替换已回避的分配。替补走同样的冲突筛查；
   * 替补评委看不到旧评分（见 judgeWorkspace，只暴露本人评分）。
   */
  async function replaceAssignment({ assignment_id, substitute_judge_id, new_assignment_id, at }) {
    const old = mustAssignment(assignment_id);
    if (old.status !== "recused") {
      throw new DomainError("NOT_RECALLED", `分配 ${assignment_id} 未处于已回避状态，不能替换`);
    }
    await emit("ASSIGNMENT_REPLACED", "judging_assignment", assignment_id, `分配 ${assignment_id} 由替补 ${substitute_judge_id} 接替`, {
      substitute_assignment_id: new_assignment_id,
      substitute_judge_id,
    }, at);
    return proposeAssignment({
      assignment_id: new_assignment_id,
      entry_id: old.entry_id,
      judge_id: substitute_judge_id,
      stage: old.stage,
      at,
    });
  }

  // ---------- 评分：锁定、重传、调查、隔离 ----------

  function sheetContent(assignmentId, rubricVersion, criteria, evidenceRefs) {
    return { assignment_id: assignmentId, rubric_version: rubricVersion, criteria: criteria, evidence_refs: evidenceRefs };
  }

  function assertCriteria(criteria) {
    if (!Array.isArray(criteria) || criteria.length === 0) {
      throw new DomainError("BAD_CRITERIA", "评分维度不能为空");
    }
    for (const item of criteria) {
      if (typeof item?.name !== "string" || typeof item?.score !== "number") {
        throw new DomainError("BAD_CRITERIA", "评分维度必须包含 name 与数值 score");
      }
    }
  }

  /**
   * 提交评分。提交即锁定量表版本与证据：
   * - 完全相同的重传：沿用原结果，仅留审计事件（幂等）；
   * - 同编号异内容：不覆盖，转入调查，原结果继续有效直至调查解决。
   */
  async function submitScore({ sheet_id, assignment_id, rubric_version, criteria, evidence_refs = [], at }) {
    assertCriteria(criteria);
    const existing = state.sheets.get(sheet_id);
    const content = sheetContent(assignment_id, rubric_version, criteria, evidence_refs);
    const contentHash = canonicalHash(content);

    if (existing) {
      const current = existing.versions[existing.versions.length - 1];
      if (current.content_hash === contentHash) {
        await emit("SCORE_RESUBMISSION_REUSED", "score_sheet", sheet_id, `评分 ${sheet_id} 完全相同重传，沿用原结果`, {
          content_hash: contentHash,
        }, at);
        return { sheet_id, reused: true };
      }
      if (existing.status === "under_investigation") {
        throw new DomainError("INVESTIGATION_OPEN", `评分 ${sheet_id} 已在调查中，拒绝再次变更`);
      }
      await emit("INVESTIGATION_OPENED", "score_sheet", sheet_id, `评分 ${sheet_id} 同编号异内容，转入调查`, {
        original_hash: current.content_hash,
        attempted_hash: contentHash,
        attempted_content: content,
        reason: "same_id_different_content",
      }, at);
      return { sheet_id, investigation: true };
    }

    const assignment = mustAssignment(assignment_id);
    if (assignment.status !== "active") {
      throw new DomainError("ASSIGNMENT_NOT_ACTIVE", `分配 ${assignment_id} 未生效（${assignment.status}），不能评分`);
    }
    assertNotSealed(assignment.entry_id);
    await emit("SCORE_SUBMITTED", "score_sheet", sheet_id, `评分 ${sheet_id} 提交并锁定（量表 ${rubric_version}）`, {
      assignment_id,
      entry_id: assignment.entry_id,
      judge_id: assignment.judge_id,
      stage: assignment.stage,
      rubric_version,
      criteria,
      evidence_refs,
      content_hash: contentHash,
      sheet_version: 1,
    }, at);
    return { sheet_id, reused: false };
  }

  /**
   * 调查解决：keep_original 维持原表；accept_correction 把调查中暂扣的内容
   * 作为后继版本追加（旧版本保留，不原地改写）。
   */
  async function resolveInvestigation({ sheet_id, resolver_id, outcome, at }) {
    const investigation = state.investigations.get(sheet_id);
    if (!investigation || investigation.status !== "open") {
      throw new DomainError("NO_OPEN_INVESTIGATION", `评分 ${sheet_id} 没有待解决的调查`);
    }
    if (!["keep_original", "accept_correction"].includes(outcome)) {
      throw new DomainError("BAD_OUTCOME", `未知调查结论：${outcome}`);
    }
    const sheet = state.sheets.get(sheet_id);
    await emit("INVESTIGATION_RESOLVED", "score_sheet", sheet_id, `评分 ${sheet_id} 调查解决：${outcome}`, {
      resolver_id,
      outcome,
    }, at);
    if (outcome === "accept_correction") {
      const attempted = investigation.attempted;
      await emit("SCORE_SUBMITTED", "score_sheet", sheet_id, `评分 ${sheet_id} 更正版本生效`, {
        assignment_id: sheet.assignment_id,
        entry_id: sheet.entry_id,
        judge_id: sheet.judge_id,
        stage: sheet.stage,
        rubric_version: attempted.rubric_version,
        criteria: attempted.criteria,
        evidence_refs: attempted.evidence_refs,
        content_hash: canonicalHash(attempted),
        sheet_version: sheet.versions.length + 1,
        supersedes: sheet.versions.length,
      }, at);
    }
    return { sheet_id, outcome };
  }

  // ---------- 阶段名单与追加决定 ----------

  /** 公布阶段名单：公布后不可改写，每个阶段只能公布一次。 */
  async function publishStageList({ stage, advanced_entry_ids, at }) {
    if (state.stageLists.has(stage)) {
      throw new DomainError("STAGE_ALREADY_PUBLISHED", `阶段 ${stage} 名单已公布，不能重写`);
    }
    await emit("STAGE_LIST_PUBLISHED", "stage_list", stage, `公布阶段 ${stage} 晋级名单`, {
      advanced_entry_ids,
    }, at);
    return { stage };
  }

  /**
   * 对已公布阶段追加决定：暂缓（hold）、复核（review）、更正（correction）。
   * 旧名单保持原样，决定按顺序追加，最终状态由全部记录解释。
   */
  async function appendDecision({ stage, entry_id, kind, rationale, corrected_to = null, source = "committee", appeal_id = null, at }) {
    if (!state.stageLists.has(stage)) {
      throw new DomainError("STAGE_NOT_PUBLISHED", `阶段 ${stage} 尚未公布，不能追加决定`);
    }
    mustEntry(entry_id);
    if (!DECISION_KINDS.includes(kind)) throw new DomainError("BAD_KIND", `未知决定类型：${kind}`);
    if (kind === "correction" && !["advanced", "not_advanced"].includes(corrected_to)) {
      throw new DomainError("CORRECTED_TO_REQUIRED", "更正决定必须给出 corrected_to（advanced/not_advanced）");
    }
    if (isSealed(entry_id)) throw new DomainError("CASE_SEALED", `案件 ${entry_id} 已封卷，禁止再变更`);
    await emit("DECISION_APPENDED", "stage_list", stage, `阶段 ${stage} 对 ${entry_id} 追加${kind}决定`, {
      entry_id, kind, corrected_to, rationale, source, appeal_id,
    }, at);
    return { stage, entry_id, kind };
  }

  // ---------- 申诉：分批材料、法务与业务分别签署 ----------

  /** 开启申诉。可针对任何已公布阶段（包括更早阶段，即跨阶段申诉）。 */
  async function openAppeal({ appeal_id, entry_id, stage, grounds, at }) {
    mustEntry(entry_id);
    assertNotSealed(entry_id);
    if (!state.stageLists.has(stage)) {
      throw new DomainError("STAGE_NOT_PUBLISHED", `阶段 ${stage} 尚未公布，不能申诉`);
    }
    if (state.appeals.has(appeal_id)) throw new DomainError("APPEAL_EXISTS", `申诉编号已存在：${appeal_id}`);
    await emit("APPEAL_OPENED", "appeal_case", appeal_id, `开启申诉 ${appeal_id}（${entry_id}，${stage}）`, {
      entry_id, stage, grounds,
    }, at);
    return { appeal_id };
  }

  /** 申诉材料可分批到达；同批次同内容幂等，同批次异内容拒绝。 */
  async function submitAppealMaterial({ appeal_id, batch_id, items, at }) {
    const appeal = mustAppeal(appeal_id);
    if (appeal.status !== "open") throw new DomainError("APPEAL_CLOSED", `申诉 ${appeal_id} 已裁决，拒收材料`);
    const batchHash = canonicalHash(items);
    if (appeal.batches.has(batch_id)) {
      if (appeal.batches.get(batch_id) === batchHash) return { appeal_id, batch_id, reused: true };
      throw new DomainError("BATCH_CONFLICT", `批次 ${batch_id} 与已收材料内容不一致`);
    }
    await emit("APPEAL_MATERIAL_RECEIVED", "appeal_case", appeal_id, `申诉 ${appeal_id} 收到材料批次 ${batch_id}`, {
      batch_id,
      item_count: items.length,
      batch_hash: batchHash,
    }, at);
    return { appeal_id, batch_id, reused: false };
  }

  /** 法务或业务签署意见；每个角色只能签署一次。 */
  async function signAppeal({ appeal_id, role, signer_id, outcome, note = "", at }) {
    const appeal = mustAppeal(appeal_id);
    if (appeal.status !== "open") throw new DomainError("APPEAL_CLOSED", `申诉 ${appeal_id} 已裁决，拒绝签署`);
    if (!SIGNOFF_ROLES.includes(role)) throw new DomainError("BAD_ROLE", `未知签署角色：${role}`);
    if (!APPEAL_OUTCOMES.includes(outcome)) throw new DomainError("BAD_OUTCOME", `未知裁决意见：${outcome}`);
    if (appeal.signoffs[role]) throw new DomainError("ROLE_ALREADY_SIGNED", `${role} 已签署，不能重复`);
    await emit("APPEAL_SIGNOFF_RECORDED", "appeal_case", appeal_id, `申诉 ${appeal_id} ${role} 签署：${outcome}`, {
      role, signer_id, outcome, note,
    }, at);
    return { appeal_id, role };
  }

  /**
   * 裁决：必须法务与业务分别签署且意见一致。
   * remand/correct 会联动追加阶段决定（复核/更正），来源标记为该申诉。
   */
  async function ruleAppeal({ appeal_id, corrected_to = null, at }) {
    const appeal = mustAppeal(appeal_id);
    if (appeal.status !== "open") throw new DomainError("APPEAL_CLOSED", `申诉 ${appeal_id} 已裁决`);
    const { legal, business } = appeal.signoffs;
    if (!legal || !business) {
      throw new DomainError("SIGNOFF_INCOMPLETE", "裁决需要法务与业务分别签署");
    }
    if (legal.outcome !== business.outcome) {
      throw new DomainError("SIGNOFF_DIVERGED", `法务（${legal.outcome}）与业务（${business.outcome}）意见不一致`);
    }
    const outcome = legal.outcome;
    if (outcome === "correct" && !["advanced", "not_advanced"].includes(corrected_to)) {
      throw new DomainError("CORRECTED_TO_REQUIRED", "更正裁决必须给出 corrected_to（advanced/not_advanced）");
    }
    await emit("APPEAL_RULED", "appeal_case", appeal_id, `申诉 ${appeal_id} 裁决：${outcome}`, {
      outcome, corrected_to,
    }, at);
    if (outcome === "remand") {
      await appendDecision({ stage: appeal.stage, entry_id: appeal.entry_id, kind: "review", rationale: "申诉裁决：复核", source: "appeal", appeal_id, at });
    }
    if (outcome === "correct") {
      await appendDecision({ stage: appeal.stage, entry_id: appeal.entry_id, kind: "correction", corrected_to, rationale: "申诉裁决：更正", source: "appeal", appeal_id, at });
    }
    return { appeal_id, outcome };
  }

  // ---------- 封卷、通知与中断恢复 ----------

  /**
   * 封卷。前置条件：无待确认冲突、无未裁决申诉、无未解决调查。
   * 并发安全：CASE_SEALED 的版本由事件库原子校验，并发封卷只有一笔成功。
   */
  async function sealCase({ entry_id, at }) {
    mustEntry(entry_id);
    if (isSealed(entry_id)) throw new DomainError("CASE_SEALED", `案件 ${entry_id} 已封卷`);
    for (const conflict of state.conflicts.values()) {
      if (conflict.entry_id === entry_id && conflict.status === "flagged") {
        throw new DomainError("PENDING_CONFLICT", `案件 ${entry_id} 存在待确认冲突 ${conflict.conflict_id}`);
      }
    }
    for (const appeal of state.appeals.values()) {
      if (appeal.entry_id === entry_id && appeal.status === "open") {
        throw new DomainError("OPEN_APPEAL", `案件 ${entry_id} 存在未裁决申诉 ${appeal.appeal_id}`);
      }
    }
    for (const sheet of state.sheets.values()) {
      if (sheet.entry_id === entry_id && sheet.status === "under_investigation") {
        throw new DomainError("OPEN_INVESTIGATION", `案件 ${entry_id} 存在未解决调查 ${sheet.sheet_id}`);
      }
    }
    const finalStatus = finalStatusFor(entry_id);
    await emit("CASE_SEALED", "selection_case", entry_id, `案件 ${entry_id} 封卷`, { final_status: finalStatus }, at);
    await emit("NOTIFICATION_QUEUED", "selection_case", entry_id, `案件 ${entry_id} 封卷通知入队`, {
      notif_id: `notif-${entry_id}-case_sealed`,
      kind: "case_sealed",
      recipient: "secretariat",
    }, at);
    await emit("DECISION_FINALIZED", "selection_case", entry_id, `案件 ${entry_id} 最终决定：${finalStatus}`, {
      final_status: finalStatus,
    }, at);
    return { entry_id, final_status: finalStatus };
  }

  /** 发送全部待发送通知（幂等：只处理 queued）。 */
  async function flushNotifications({ at } = {}) {
    const sent = [];
    for (const notification of [...state.notifications.values()]) {
      if (notification.status !== "queued") continue;
      await emit("NOTIFICATION_SENT", "selection_case", notification.entry_id, `通知 ${notification.notif_id} 已发送`, {
        notif_id: notification.notif_id,
      }, at);
      sent.push(notification.notif_id);
    }
    return sent;
  }

  /**
   * 系统中断后恢复：返回未封卷案件（供继续办理），并补发积压通知。
   * 服务在同一事件库上重建后即可调用。
   */
  async function resume({ at } = {}) {
    const unsealed = [...state.entries.keys()].filter((entryId) => !isSealed(entryId));
    const notificationsSent = await flushNotifications({ at });
    return { unsealed_entries: unsealed, notifications_sent: notificationsSent };
  }

  // ---------- 查询与解释 ----------

  /** 某候选人在某阶段的状态轨迹：公布名单为基线，追加决定依次作用。 */
  function stageStatus(stage, entryId) {
    const list = state.stageLists.get(stage);
    if (!list) return null;
    const base = list.advanced.has(entryId) ? "advanced" : "not_advanced";
    const trail = [{ status: base, via: "published_list", at: list.published_at }];
    let status = base;
    for (const decision of state.decisions.filter((d) => d.stage === stage && d.entry_id === entryId)) {
      if (decision.kind === "hold") status = "held";
      else if (decision.kind === "review") status = "under_review";
      else if (decision.kind === "correction") status = decision.corrected_to;
      trail.push({
        status,
        via: decision.kind,
        rationale: decision.rationale,
        source: decision.source,
        appeal_id: decision.appeal_id,
        at: decision.at,
      });
    }
    return { base_status: base, effective_status: status, status_trail: trail };
  }

  function finalStatusFor(entryId) {
    const involved = [...state.stageLists.values()]
      .filter((list) => list.advanced.has(entryId)
        || state.decisions.some((d) => d.stage === list.stage && d.entry_id === entryId)
        || [...state.sheets.values()].some((s) => s.entry_id === entryId && s.stage === list.stage))
      .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
    const last = involved[involved.length - 1];
    if (!last) return "pending";
    return stageStatus(last.stage, entryId).effective_status;
  }

  function sheetTotal(version) {
    return version.criteria.reduce((sum, item) => sum + item.score, 0);
  }

  /**
   * 解释一名候选人的全程：每个阶段用了哪些有效评分、哪些被排除及原因、
   * 追加决定如何改变最终状态；以及评审包、申诉与封卷结果。
   */
  function explainCandidate(entryId) {
    const entry = mustEntry(entryId);
    const stageNames = new Set();
    for (const sheet of state.sheets.values()) if (sheet.entry_id === entryId) stageNames.add(sheet.stage);
    for (const [stage, list] of state.stageLists) if (list.advanced.has(entryId)) stageNames.add(stage);
    for (const decision of state.decisions) if (decision.entry_id === entryId) stageNames.add(decision.stage);

    const stages = [...stageNames].sort().map((stage) => {
      const scoresUsed = [];
      const scoresExcluded = [];
      for (const sheet of state.sheets.values()) {
        if (sheet.entry_id !== entryId || sheet.stage !== stage) continue;
        const current = sheet.versions[sheet.versions.length - 1];
        const base = {
          sheet_id: sheet.sheet_id,
          judge_id: sheet.judge_id,
          assignment_id: sheet.assignment_id,
          rubric_version: current.rubric_version,
          sheet_version: current.sheet_version,
          total: sheetTotal(current),
        };
        if (sheet.status === "quarantined") {
          scoresExcluded.push({ ...base, reason: "quarantined", detail: `回避隔离（冲突 ${sheet.quarantine.conflict_id}）` });
        } else {
          // under_investigation 期间原结果继续有效
          scoresUsed.push({ ...base, under_investigation: sheet.status === "under_investigation" });
        }
        for (const old of sheet.versions.slice(0, -1)) {
          scoresExcluded.push({
            sheet_id: sheet.sheet_id,
            judge_id: sheet.judge_id,
            sheet_version: old.sheet_version,
            total: sheetTotal(old),
            reason: "superseded",
            detail: "被调查后的更正版本取代",
          });
        }
      }
      const status = stageStatus(stage, entryId);
      return {
        stage,
        published: state.stageLists.has(stage),
        base_status: status?.base_status ?? null,
        effective_status: status?.effective_status ?? null,
        status_trail: status?.status_trail ?? [],
        scores_used: scoresUsed,
        scores_excluded: scoresExcluded,
        decisions: state.decisions.filter((d) => d.stage === stage && d.entry_id === entryId),
      };
    });

    return {
      entry_id: entryId,
      candidate_ref: entry.candidate_ref,
      qualification_version: entry.qualification_version,
      packages: [...entry.packages.values()].map((pkg) => ({
        package_id: pkg.package_id,
        qualification_version: pkg.qualification_version,
        package_hash: pkg.package_hash,
        redacted_fields: pkg.redacted_fields,
      })),
      stages,
      appeals: [...state.appeals.values()]
        .filter((appeal) => appeal.entry_id === entryId)
        .map((appeal) => ({
          appeal_id: appeal.appeal_id,
          stage: appeal.stage,
          grounds: appeal.grounds,
          status: appeal.status,
          batches: [...appeal.batches.keys()],
          signoffs: appeal.signoffs,
          ruling: appeal.ruling,
        })),
      sealed: isSealed(entryId),
      final_status: state.cases.get(entryId)?.final_status ?? null,
    };
  }

  /**
   * 评委工作台：只看得到脱敏评审包与本人评分。
   * 替补评委因此看不到被回避评委的旧分，实现盲评重评。
   */
  function judgeWorkspace(judgeId, entryId) {
    const entry = mustEntry(entryId);
    const pkg = entry.packages.get(entry.qualification_version) ?? null;
    return {
      entry_id: entryId,
      judge_id: judgeId,
      review_package: pkg
        ? { package_id: pkg.package_id, qualification_version: pkg.qualification_version, content: pkg.content }
        : null,
      my_sheets: [...state.sheets.values()]
        .filter((sheet) => sheet.entry_id === entryId && sheet.judge_id === judgeId)
        .map((sheet) => ({
          sheet_id: sheet.sheet_id,
          stage: sheet.stage,
          status: sheet.status,
          current: sheet.versions[sheet.versions.length - 1],
        })),
    };
  }

  return {
    // 命令
    acceptEntry,
    reviseEntry,
    declareRecusal,
    confirmConflict,
    proposeAssignment,
    replaceAssignment,
    submitScore,
    resolveInvestigation,
    publishStageList,
    appendDecision,
    openAppeal,
    submitAppealMaterial,
    signAppeal,
    ruleAppeal,
    sealCase,
    flushNotifications,
    resume,
    // 查询
    explainCandidate,
    judgeWorkspace,
    listConflicts: () => [...state.conflicts.values()],
    getSheet: (sheetId) => state.sheets.get(sheetId) ?? null,
    getStageList: (stage) => state.stageLists.get(stage) ?? null,
    isSealed,
  };
}
