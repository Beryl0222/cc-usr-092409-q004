import { canonicalHash, evidenceFingerprint } from "./hashing.js";
import { DomainError, ErrorCode } from "./errors.js";
import { reduce, effectiveSheets, effectiveHash as computeEffectiveHash, aggregateResult, factOverlaps, scaleKey } from "./projection.js";

/**
 * 盲评封卷工作流。
 *
 * 设计约定：
 * - 所有业务结果都是事件；命令只做"校验 → 在锁内重读 → 追加事件批次"，不就地改数据。
 * - 任何外发通知与触发它的事件在同一 appendBatch 中落盘（原子对账）。
 * - 已公布的名单与已封卷结果永不原地改写，后续变化以 暂缓/复核/更正 决定追加。
 */
export class SealingWorkflow {
  constructor(store, { redactor = defaultRedactor, idFactory = null } = {}) {
    this.store = store;
    this.redactor = redactor;
    this.idFactory = idFactory;
  }

  #id(prefix) {
    return this.idFactory ? this.idFactory(prefix) : this.store.newId(prefix);
  }

  #snapshot() {
    return reduce(this.store.readAll());
  }

  #mustPacket(state, packetId) {
    const packet = state.packets.get(packetId);
    if (!packet) throw new DomainError(ErrorCode.NOT_FOUND, `评审包不存在：${packetId}`);
    return packet;
  }

  #mustEntry(state, entryId) {
    const entry = state.entries.get(entryId);
    if (!entry) throw new DomainError(ErrorCode.NOT_FOUND, `报名记录不存在：${entryId}`);
    return entry;
  }

  #enqueue(items, state, { channel, recipient, subject, body, ref, dedupKey }) {
    for (const message of state.outbox.values()) {
      if (message.dedupKey === dedupKey) return;
    }
    items.push({
      event: {
        event_type: "OUTBOX_ENQUEUED",
        aggregate_type: "outbox_message",
        aggregate_id: this.#id("msg"),
        summary: subject,
        payload: { dedup_key: dedupKey, channel, recipient, subject, body, ref: ref ?? {} },
      },
    });
  }

  // ── 报名与资格版本 ───────────────────────────────────────────────

  acceptEntry({ entryId, candidateId, qualification, materials, personal }) {
    return this.store.append({
      event_type: "ENTRY_ACCEPTED",
      aggregate_type: "candidate_entry",
      aggregate_id: entryId,
      summary: `报名受理：${candidateId}`,
      payload: {
        candidate_id: candidateId,
        qualification: qualification ?? {},
        personal: personal ?? {},
        materials: materials ?? [],
        version_hash: canonicalHash({ qualification: qualification ?? {}, materials: materials ?? [] }),
      },
    }, 0);
  }

  /**
   * 追加资格/材料版本。受理时已固化版本 1；这里提交 version >= 2 的新版本。
   * 旧版本永不删除或改写——评审包按某一版本号生成脱敏快照。
   */
  submitMaterialVersion({ entryId, version, qualification, materials, personal }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const entry = this.#mustEntry(state, entryId);
      const expected = this.store.versionOf("candidate_entry", entryId);
      if (version !== entry.latestVersion + 1) {
        throw new DomainError(ErrorCode.VERSION_CONFLICT,
          `材料版本必须连续：期望 ${entry.latestVersion + 1}，收到 ${version}`,
          { expectedVersion: entry.latestVersion + 1, received: version });
      }
      this.store.appendBatch([{
        event: {
          event_type: "MATERIAL_VERSION_SUBMITTED",
          aggregate_type: "candidate_entry",
          aggregate_id: entryId,
          summary: `报名材料更新至资格版本 ${version}`,
          payload: {
            version,
            qualification: qualification ?? {},
            personal: personal ?? {},
            materials: materials ?? [],
            version_hash: canonicalHash({ qualification: qualification ?? {}, materials: materials ?? [] }),
          },
        },
        expectedVersion: expected,
      }]);
      return { entryId, version };
    });
  }

  // ── 量表版本 ─────────────────────────────────────────────────────

  registerScale({ scaleId, version, rubric }) {
    const state = this.#snapshot();
    const rubricHash = canonicalHash(rubric);
    if (state.scales.has(scaleKey(scaleId, version))) {
      throw new DomainError(ErrorCode.CONFLICT, `量表版本已存在：${scaleId}@${version}`);
    }
    this.store.append({
      event_type: "SCALE_VERSION_REGISTERED",
      aggregate_type: "scale_version",
      aggregate_id: `${scaleId}@${version}`,
      summary: `登记评分量表 ${scaleId} 版本 ${version}`,
      payload: { scale_id: scaleId, version, rubric, rubric_hash: rubricHash },
    }, 0);
    return { scaleId, version, rubricHash };
  }

  // ── 脱敏评审包（按资格版本冻结快照） ─────────────────────────────

  generateReviewPacket({ entryId, packetId, stage, qualVersion, scaleId, scaleVersion, visibleFields }) {
    const state = this.#snapshot();
    const entry = this.#mustEntry(state, entryId);
    if (state.packets.has(packetId)) throw new DomainError(ErrorCode.CONFLICT, `评审包已存在：${packetId}`);
    const materialVersion = entry.versions.get(qualVersion);
    if (!materialVersion) {
      throw new DomainError(ErrorCode.PRECONDITION, `资格版本 ${qualVersion} 不存在（最新为 ${entry.latestVersion}）`);
    }
    const scale = state.scales.get(scaleKey(scaleId, scaleVersion));
    if (!scale) throw new DomainError(ErrorCode.PRECONDITION, `量表版本未登记：${scaleId}@${scaleVersion}`);

    // 脱敏：个人字段绝不进入评审包；只暴露白名单字段与非身份材料。
    const redacted = this.redactor({
      qualification: materialVersion.qualification,
      materials: materialVersion.materials,
      visibleFields: visibleFields ?? ["works", "credentials"],
    });
    const snapshotHash = canonicalHash({
      entry_id: entryId,
      stage,
      qual_version: qualVersion,
      version_hash: materialVersion.hash,
      visible: redacted,
      scale: scale.rubricHash,
    });
    const reviewToken = this.#id("token");

    this.store.append({
      event_type: "REVIEW_PACKET_GENERATED",
      aggregate_type: "review_packet",
      aggregate_id: packetId,
      summary: `生成 ${stage} 阶段脱敏评审包（资格版本 ${qualVersion}）`,
      payload: {
        packet_id: packetId,
        entry_id: entryId,
        candidate_id: entryId,
        stage,
        qual_version: qualVersion,
        scale_id: scaleId,
        scale_version: scaleVersion,
        review_token: reviewToken,
        visible_fields: redacted.visibleFields,
        exposed_materials: redacted.materials,
        redacted_qualification: redacted.qualification,
        snapshot_hash: snapshotHash,
      },
    }, 0);
    return { packetId, snapshotHash, reviewToken };
  }

  // ── 回避事实（带生效区间） ───────────────────────────────────────

  declareRecusalFact({ factId, reviewerId, candidateId, kind, detail, validFrom, validTo }) {
    if (!validFrom) throw new DomainError(ErrorCode.VALIDATION, "回避事实必须提供生效起点 valid_from");
    if (validTo && validTo < validFrom) throw new DomainError(ErrorCode.VALIDATION, "生效区间终点早于起点");
    const state = this.#snapshot();
    if (state.facts.has(factId)) throw new DomainError(ErrorCode.CONFLICT, `回避事实已存在：${factId}`);
    this.store.append({
      event_type: "RECUSAL_FACT_DECLARED",
      aggregate_type: "recusal_fact",
      aggregate_id: factId,
      summary: `登记回避关系：评委 ${reviewerId} 与候选人 ${candidateId}（${kind}，${validFrom} 起）`,
      payload: {
        fact_id: factId,
        reviewer_id: reviewerId,
        candidate_id: candidateId,
        kind, // employment（任职） | collaboration（合作） | supervision（指导）
        detail: detail ?? "",
        valid_from: validFrom,
        valid_to: validTo ?? null,
      },
    }, 0);
    return { factId };
  }

  /** 找出评委对某候选人在指定时间窗内生效的回避事实。 */
  detectConflicts(state, reviewerId, candidateId, windowFrom, windowTo) {
    return [...state.facts.values()].filter(
      (f) => f.reviewerId === reviewerId
        && f.candidateId === candidateId
        && factOverlaps(f, windowFrom, windowTo),
    );
  }

  // ── 分配：自动提示冲突，独立合规人员确认 ─────────────────────────

  /**
   * 统一的分配事件构造（普通分配与替补分配共用，保证替补同样经过冲突检测）：
   * REVIEWER_ASSIGNED + 对每个生效关系的 CONFLICT_FLAGGED + 合规队列通知。
   */
  #buildAssignmentItems(state, packet, reviewerId, role, round, complianceOfficerId = null) {
    const assignmentId = this.#id("asg");
    const conflicts = this.detectConflicts(state, reviewerId, packet.entryId, packet.generatedAt, this.store.now());
    const items = [{
      event: {
        event_type: "REVIEWER_ASSIGNED",
        aggregate_type: "review_packet",
        aggregate_id: packet.id,
        summary: role === "substitute"
          ? `指派替补评委 ${reviewerId}（第 ${round} 轮，盲视旧分）`
          : `分配评委 ${reviewerId}（${role}）`,
        payload: {
          assignment_id: assignmentId,
          reviewer_id: reviewerId,
          role,
          round,
          conflict_detected: conflicts.length > 0,
        },
      },
    }];
    for (const fact of conflicts) {
      items.push({
        event: {
          event_type: "CONFLICT_FLAGGED",
          aggregate_type: "review_packet",
          aggregate_id: packet.id,
          summary: `自动提示冲突：评委 ${reviewerId} 与候选人存在 ${fact.kind} 关系，待合规确认`,
          payload: {
            flag_id: this.#id("flag"),
            assignment_id: assignmentId,
            reviewer_id: reviewerId,
            fact_id: fact.id,
            reason: `${fact.kind} 关系生效区间 ${fact.validFrom}..${fact.validTo ?? "至今"} 与评审期重叠`,
            auto_flagged: true,
          },
        },
      });
    }
    if (conflicts.length > 0) {
      this.#enqueue(items, state, {
        channel: "compliance_queue",
        recipient: complianceOfficerId ?? "compliance_officer",
        subject: `待确认回避冲突：评审包 ${packet.id} / 评委 ${reviewerId}`,
        body: `系统检测到 ${conflicts.length} 项生效关系，请独立合规人员确认或驳回。`,
        ref: { packet_id: packet.id, reviewer_id: reviewerId },
        dedupKey: `conflict-confirm:${packet.id}:${reviewerId}:${conflicts.map((f) => f.id).sort().join(",")}`,
      });
    }
    return { items, assignmentId, conflictFlagged: conflicts.length > 0, factIds: conflicts.map((f) => f.id) };
  }

  assignReviewer({ packetId, reviewerId, role = "voter", complianceOfficerId = null }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const packet = this.#mustPacket(state, packetId);
      if (packet.sealedAt) throw new DomainError(ErrorCode.PANEL_FROZEN, "评审包已封卷，不可再分配评委");
      const alreadyActive = packet.assignments.some(
        (a) => a.reviewerId === reviewerId && a.status !== "recused",
      );
      if (alreadyActive) throw new DomainError(ErrorCode.CONFLICT, `评委 ${reviewerId} 已在评审组中（含待确认冲突），不可重复分配`);
      const built = this.#buildAssignmentItems(state, packet, reviewerId, role, 1, complianceOfficerId);
      this.store.appendBatch(built.items);
      return { assignmentId: built.assignmentId, conflictFlagged: built.conflictFlagged, factIds: built.factIds };
    });
  }

  #resolveFlag({ packetId, flagId, complianceOfficerId, note, confirm }) {
    if (!complianceOfficerId) throw new DomainError(ErrorCode.VALIDATION, "必须由独立合规人员签署处理");
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const packet = this.#mustPacket(state, packetId);
      const flag = packet.flags.find((f) => f.flagId === flagId);
      if (!flag) throw new DomainError(ErrorCode.NOT_FOUND, `冲突提示不存在：${flagId}`);
      if (flag.disposition !== "pending") {
        throw new DomainError(ErrorCode.CONFLICT, `冲突已处理：${flag.disposition}`);
      }
      const items = [{
        event: {
          event_type: confirm ? "CONFLICT_CONFIRMED" : "CONFLICT_DISMISSED",
          aggregate_type: "review_packet",
          aggregate_id: packetId,
          summary: confirm
            ? `合规确认回避成立：评委 ${flag.reviewerId} 退出评审包 ${packetId}`
            : `合规驳回冲突提示：评委 ${flag.reviewerId} 可继续评审`,
          payload: {
            flag_id: flagId,
            assignment_id: flag.assignmentId,
            compliance_officer_id: complianceOfficerId,
            fact_id: flag.factId,
            note: note ?? "",
          },
        },
      }];
      if (confirm) {
        items.push({
          event: {
            event_type: "REVIEWER_RECUSED",
            aggregate_type: "review_packet",
            aggregate_id: packetId,
            summary: `评委 ${flag.reviewerId} 因回避退出`,
            payload: { assignment_id: flag.assignmentId, reviewer_id: flag.reviewerId, fact_id: flag.factId },
          },
        });
        // 该评委若已评分，分数即时隔离（尚未封卷，尚未影响名单）。
        for (const sheet of state.sheets.values()) {
          if (sheet.packetId === packetId && sheet.reviewerId === flag.reviewerId && sheet.status === "effective") {
            items.push({
              event: {
                event_type: "SCORE_EXCLUDED",
                aggregate_type: "score_sheet",
                aggregate_id: sheet.id,
                summary: `因回避成立隔离评分：${sheet.id}`,
                payload: { reason: "conflict_confirmed", fact_id: flag.factId },
              },
            });
            items.push({
              event: {
                event_type: "AFFECTED_SCORE_ISOLATED",
                aggregate_type: "review_packet",
                aggregate_id: packetId,
                summary: `仅隔离受影响评分：评委 ${flag.reviewerId} 的评分被排除`,
                payload: { sheet_id: sheet.id, reviewer_id: flag.reviewerId, fact_id: flag.factId, reason: "conflict_confirmed" },
              },
            });
          }
        }
        this.#enqueue(items, state, {
          channel: "secretary_queue",
          recipient: "committee_secretary",
          subject: `需指派替补评委：评审包 ${packetId}`,
          body: `评委 ${flag.reviewerId} 因回避退出，请开补充轮次并指派替补（替补不可见旧分）。`,
          ref: { packet_id: packetId, reviewer_id: flag.reviewerId },
          dedupKey: `substitute-needed:${packetId}:${flag.assignmentId}`,
        });
      }
      this.store.appendBatch(items);
      return { resolved: confirm ? "confirmed" : "dismissed" };
    });
  }

  confirmConflict(args) {
    return this.#resolveFlag({ ...args, confirm: true });
  }

  dismissConflict(args) {
    return this.#resolveFlag({ ...args, confirm: false });
  }

  // ── 迟报关系：只隔离受影响评分，按阶段分流 ───────────────────────

  /**
   * 终评前才披露的共同项目等关系。登记事实后：
   * - 仅隔离该评委对该候选人的有效评分（其他评委、其他候选人不受影响）；
   * - 未封卷：自动开补充轮次，等待替补；
   * - 已封卷/已公布：旧结果保留，追加复核或暂缓，通知秘书处理。
   */
  declareLateRecusal({ factId, reviewerId, candidateId, kind, detail, validFrom, validTo, substituteReviewerId = null }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      if (state.facts.has(factId)) throw new DomainError(ErrorCode.CONFLICT, `回避事实已存在：${factId}`);
      const items = [{
        event: {
          event_type: "RECUSAL_FACT_DECLARED",
          aggregate_type: "recusal_fact",
          aggregate_id: factId,
          summary: `迟报回避关系：评委 ${reviewerId} 与候选人 ${candidateId}（${kind}）`,
          payload: {
            fact_id: factId,
            reviewer_id: reviewerId,
            candidate_id: candidateId,
            kind,
            detail: detail ?? "终评前才披露",
            valid_from: validFrom,
            valid_to: validTo ?? null,
            reported_late: true,
          },
        },
      }];

      const affectedPackets = [];
      for (const packet of state.packets.values()) {
        if (packet.entryId !== candidateId) continue;
        const fact = { validFrom, validTo };
        const windowFrom = packet.generatedAt;
        const windowTo = packet.sealedAt ?? this.store.now();
        if (!factOverlaps(fact, windowFrom, windowTo)) continue;
        const assigned = packet.assignments.some(
          (a) => a.reviewerId === reviewerId && a.status !== "recused",
        );
        if (!assigned) continue;
        const sheets = [...state.sheets.values()].filter(
          (s) => s.packetId === packet.id && s.reviewerId === reviewerId && s.status === "effective",
        );
        affectedPackets.push({ packet, sheets });
        items.push({
          event: {
            event_type: "REVIEWER_RECUSED",
            aggregate_type: "review_packet",
            aggregate_id: packet.id,
            summary: `迟报关系：评委 ${reviewerId} 退出 ${packet.id} 的评审`,
            payload: { reviewer_id: reviewerId, fact_id: factId, reported_late: true },
          },
        });
        for (const sheet of sheets) {
          items.push({
            event: {
              event_type: "SCORE_EXCLUDED",
              aggregate_type: "score_sheet",
              aggregate_id: sheet.id,
              summary: `迟报关系隔离受影响评分：${sheet.id}（审计保留，不删除）`,
              payload: { reason: "late_declared_fact", fact_id: factId },
            },
          });
          items.push({
            event: {
              event_type: "AFFECTED_SCORE_ISOLATED",
              aggregate_type: "review_packet",
              aggregate_id: packet.id,
              summary: `迟报关系：仅隔离评委 ${reviewerId} 的 ${sheets.length} 项评分`,
              payload: { sheet_id: sheet.id, reviewer_id: reviewerId, fact_id: factId, reason: "late_declared_fact" },
            },
          });
        }
      }

      for (const { packet } of affectedPackets) {
        const published = packet.decisions.some((d) => d.kind === "published");
        if (!packet.sealedAt) {
          const nextRound = packet.supplementalRounds.length + 2;
          items.push({
            event: {
              event_type: "SUPPLEMENTAL_ROUND_OPENED",
              aggregate_type: "review_packet",
              aggregate_id: packet.id,
              summary: `迟报关系：开启第 ${nextRound} 轮替补重评（旧分隔离，替补不可见）`,
              payload: { round: nextRound, reason: "late_declared_fact", ref_id: factId },
            },
          });
          if (substituteReviewerId) {
            const sub = this.#buildAssignmentItems(state, packet, substituteReviewerId, "substitute", nextRound);
            items.push(...sub.items);
          }
        } else if (!published) {
          items.push({
            event: {
              event_type: "REVIEW_ADDED",
              aggregate_type: "review_packet",
              aggregate_id: packet.id,
              summary: "已封卷未公布：追加复核决定（旧封卷结果保留），待替补重评后更正",
              payload: { reason: "late_declared_fact", ref_id: factId, status: "pending_rescore" },
            },
          });
        } else {
          items.push({
            event: {
              event_type: "HOLD_PLACED",
              aggregate_type: "review_packet",
              aggregate_id: packet.id,
              summary: "已公布阶段：追加暂缓决定，冻结晋级效力直至复核更正",
              payload: { reason: "late_declared_fact", ref_id: factId },
            },
          });
        }
        this.#enqueue(items, state, {
          channel: "secretary_queue",
          recipient: "committee_secretary",
          subject: `迟报回避需处置：评审包 ${packet.id}`,
          body: published
            ? "该候选人已在公布名单中：已追加暂缓，请安排替补重评并发布更正决定，不得改写旧名单。"
            : "受影响评分已隔离（审计保留），请完成替补重评。",
          ref: { packet_id: packet.id, fact_id: factId, published },
          dedupKey: `late-recusal:${factId}:${packet.id}`,
        });
      }
      this.store.appendBatch(items);
      return {
        factId,
        affectedPackets: affectedPackets.map(({ packet, sheets }) => ({
          packetId: packet.id,
          sheetIds: sheets.map((s) => s.id),
          phase: !packet.sealedAt ? "unsealed" : packet.decisions.some((d) => d.kind === "published") ? "published" : "sealed",
        })),
      };
    });
  }

  /** 秘书手动开补充轮次并指派替补（合规确认后使用）。 */
  openSupplementalRound({ packetId, reason, substituteReviewerId = null, refId = null }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const packet = this.#mustPacket(state, packetId);
      if (packet.sealedAt) throw new DomainError(ErrorCode.ALREADY_SEALED, "已封卷包的补充评审走复核/更正流程");
      const round = packet.supplementalRounds.length + 2;
      const items = [{
        event: {
          event_type: "SUPPLEMENTAL_ROUND_OPENED",
          aggregate_type: "review_packet",
          aggregate_id: packetId,
          summary: `开启第 ${round} 轮补充评审`,
          payload: { round, reason, ref_id: refId },
        },
      }];
      if (substituteReviewerId) {
        items.push(...this.#buildAssignmentItems(state, packet, substituteReviewerId, "substitute", round).items);
      }
      this.store.appendBatch(items);
      return { round };
    });
  }

  /**
   * 已封卷（复核中）或已公布（暂缓中）的包开启重评轮次并指派替补。
   * 旧封卷与旧名单均不动；替补在新轮次盲视旧分。
   */
  openRescoreRound({ packetId, substituteReviewerId, reason = "rescore", refId = null }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const packet = this.#mustPacket(state, packetId);
      if (!packet.sealedAt) throw new DomainError(ErrorCode.PRECONDITION, "未封卷包使用普通补充轮次");
      if (!["pending_rescore", "held"].includes(packet.rescoreStatus)) {
        throw new DomainError(ErrorCode.PRECONDITION, "包不处于复核/暂缓状态，不能开启重评");
      }
      if (!substituteReviewerId) throw new DomainError(ErrorCode.VALIDATION, "重评必须指派替补评委");
      const round = packet.supplementalRounds.length + 2;
      const items = [
        {
          event: {
            event_type: "SUPPLEMENTAL_ROUND_OPENED",
            aggregate_type: "review_packet",
            aggregate_id: packetId,
            summary: `复核重评：开启第 ${round} 轮（替补盲视旧分）`,
            payload: { round, reason, ref_id: refId },
          },
        },
        ...this.#buildAssignmentItems(state, packet, substituteReviewerId, "substitute", round).items,
      ];
      this.store.appendBatch(items);
      return { round };
    });
  }

  // ── 评分提交：锁定量表版本与证据、幂等、同编号异内容 ─────────────

  submitScore({ sheetId, packetId, reviewerId, values, evidenceHashes, total }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const packet = this.#mustPacket(state, packetId);
      if (packet.sealedAt && !["pending_rescore", "held"].includes(packet.rescoreStatus)) {
        throw new DomainError(ErrorCode.ALREADY_SEALED, "评审包已封卷，不再接受评分");
      }

      const assignment = [...packet.assignments]
        .reverse()
        .find((a) => a.reviewerId === reviewerId);
      if (!assignment) throw new DomainError(ErrorCode.PRECONDITION, `评委 ${reviewerId} 未被分配到该评审包`);
      if (assignment.status === "recused") throw new DomainError(ErrorCode.PRECONDITION, "该评委已回避，不可提交评分");
      const pendingFlag = packet.flags.find(
        (f) => f.reviewerId === reviewerId && f.disposition === "pending",
      );
      if (pendingFlag) throw new DomainError(ErrorCode.PRECONDITION, "冲突提示尚待合规确认，评分暂不受理");

      const round = assignment.round;
      // 量表版本在评审包生成时锁定；评分事件携带当时的 rubric 哈希，事后量表改版不影响已提交评分。
      const scaleVersionId = packet.scaleVersionId;
      const scaleRecord = state.scales.get(scaleVersionId);
      if (!scaleRecord) throw new DomainError(ErrorCode.PRECONDITION, `评审包锁定的量表版本缺失：${scaleVersionId}`);

      const valuesHash = canonicalHash(values);
      const contentHash = canonicalHash({ values, total, evidence: evidenceFingerprint(evidenceHashes ?? []) });

      // 同编号重传：完全相同 → 沿用原结果；同编号异内容 → 进入调查。
      const existing = state.sheets.get(sheetId);
      if (existing) {
        if (existing.contentHash === contentHash) {
          return { duplicated: true, sheetId, originalSubmittedAt: existing.submittedAt, investigation: null };
        }
        const items = [];
        if (existing.status !== "quarantined") {
          const caseRef = this.#id("inv");
          items.push({
            event: {
              event_type: "SCORE_INVESTIGATION_OPENED",
              aggregate_type: "score_sheet",
              aggregate_id: sheetId,
              summary: `同编号评分内容不一致：编号 ${sheetId} 进入调查`,
              payload: {
                case_ref: caseRef,
                reason: "same_id_different_content",
                original_content_hash: existing.contentHash,
                received_content_hash: contentHash,
              },
            },
          });
          this.store.appendBatch(items);
          return { duplicated: false, sheetId, investigation: caseRef };
        }
        return { duplicated: false, sheetId, investigation: existing.investigation?.caseRef ?? null, alreadyOpen: true };
      }

      const computedTotal = total ?? computeDefaultTotal(values);
      this.store.appendBatch([{
        event: {
          event_type: "SCORE_SUBMITTED",
          aggregate_type: "score_sheet",
          aggregate_id: sheetId,
          summary: `评委 ${reviewerId} 提交第 ${round} 轮评分（量表 ${scaleVersionId} 已锁定）`,
          payload: {
            packet_id: packetId,
            stage: packet.stage,
            reviewer_id: reviewerId,
            round,
            scale_version_id: scaleVersionId,
            rubric_hash: scaleRecord.rubricHash,
            values,
            values_hash: valuesHash,
            evidence_hashes: evidenceHashes ?? [],
            total: computedTotal,
            content_hash: contentHash,
          },
        },
      }]);
      return { duplicated: false, sheetId, contentHash, scaleVersionId };
    });
  }

  resolveScoreInvestigation({ sheetId, outcome, note, complianceOfficerId }) {
    if (!["accept", "reject"].includes(outcome)) throw new DomainError(ErrorCode.VALIDATION, "outcome 必须为 accept 或 reject");
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const sheet = state.sheets.get(sheetId);
      if (!sheet || !sheet.investigation || sheet.investigation.outcome) {
        throw new DomainError(ErrorCode.PRECONDITION, "不存在待裁决的评分调查");
      }
      this.store.appendBatch([{
        event: {
          event_type: "SCORE_INVESTIGATION_RESOLVED",
          aggregate_type: "score_sheet",
          aggregate_id: sheetId,
          summary: `评分调查裁决：${outcome === "accept" ? "采信重传" : "驳回并排除"}（${sheetId}）`,
          payload: { case_ref: sheet.investigation.caseRef, outcome, note: note ?? "", compliance_officer_id: complianceOfficerId ?? null },
        },
      }]);
      return { sheetId, outcome };
    });
  }

  // ── 封卷（乐观并发；幂等） ───────────────────────────────────────

  sealPacket({ packetId, expectedVersion }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const packet = this.#mustPacket(state, packetId);
      if (packet.sealedAt) {
        // 完全相同的重复封卷请求沿用原结果。
        return { sealed: true, deduped: true, result: packet.sealedResult, sealedAt: packet.sealedAt };
      }
      const currentVersion = this.store.versionOf("review_packet", packetId);
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new DomainError(ErrorCode.VERSION_CONFLICT,
          `封卷并发冲突：评审包已从版本 ${expectedVersion} 变更至 ${currentVersion}`,
          { expectedVersion, currentVersion });
      }
      const { effective, excluded } = effectiveSheets(state, packet);
      if (effective.length === 0) {
        throw new DomainError(ErrorCode.UNSEALED, "没有任何有效评分，不能封卷");
      }
      const pendingFlags = packet.flags.filter((f) => f.disposition === "pending");
      if (pendingFlags.length > 0) throw new DomainError(ErrorCode.PRECONDITION, "仍有冲突提示待合规确认，不能封卷");
      // 每个在任评委在其所属轮次必须"有交代"：有效评分、已处理排除均可；
      // 调查中（隔离）或从未提交则不能封卷。回避评委无需评分，替补按新轮次计。
      const packetSheets = [...state.sheets.values()].filter((s) => s.packetId === packetId);
      for (const assignment of packet.assignments) {
        if (assignment.status === "recused") continue;
        const own = packetSheets.filter((s) => s.reviewerId === assignment.reviewerId && s.round === assignment.round);
        if (own.some((s) => s.status === "quarantined")) {
          throw new DomainError(ErrorCode.UNSEALED, `评委 ${assignment.reviewerId} 的评分处于调查中，不能封卷`);
        }
        if (!own.some((s) => s.status === "effective" || s.status === "excluded")) {
          throw new DomainError(ErrorCode.UNSEALED, `评委 ${assignment.reviewerId} 第 ${assignment.round} 轮尚未提交评分`);
        }
      }
      // 最后一个补充轮次（替代被隔离评分而开）必须已有有效评分；
      // 若该轮替补也被确认回避，则会再开新一轮，旧轮自然作废，无需评分。
      const supplemental = packet.supplementalRounds;
      if (supplemental.length > 0) {
        const lastRound = supplemental[supplemental.length - 1].round;
        if (!effective.some((s) => s.round === lastRound)) {
          throw new DomainError(ErrorCode.UNSEALED, `第 ${lastRound} 轮替补重评尚无有效评分，不能封卷`);
        }
      }
      const result = aggregateResult(effective);
      const hash = computeEffectiveHash(effective);
      const jobItems = [...state.sealJobs.values()]
        .filter((j) => j.packetId === packetId && j.completedAt === null)
        .map((job) => ({
          event: {
            event_type: "SEAL_JOB_COMPLETED",
            aggregate_type: "seal_job",
            aggregate_id: job.id,
            summary: `封卷作业完成：${job.id}`,
            payload: { packet_id: packetId },
          },
        }));
      this.store.appendBatch([{
        event: {
          event_type: "PACKET_SEALED",
          aggregate_type: "review_packet",
          aggregate_id: packetId,
          summary: `封卷完成：${packet.stage} 阶段平均分 ${result.average}（有效评分 ${effective.length} 份，排除 ${excluded.length} 份）`,
          payload: {
            result,
            effective_sheet_ids: effective.map((s) => s.id),
            excluded_sheet_ids: excluded.map(({ sheet: s, reason }) => ({ sheet_id: s.id, reason })),
            effective_hash: hash,
          },
        },
        expectedVersion: currentVersion,
      }, ...jobItems]);
      return { sealed: true, result, effective: effective.map((s) => s.id), excluded, effectiveHash: hash };
    });
  }

  /** 异步封卷入口：先登记作业，执行器中断后可凭事件继续。 */
  requestSeal({ packetId }) {
    const jobId = this.#id("sealjob");
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      this.#mustPacket(state, packetId);
      const items = [{
        event: {
          event_type: "SEAL_JOB_REQUESTED",
          aggregate_type: "seal_job",
          aggregate_id: jobId,
          summary: `请求封卷作业：${packetId}`,
          payload: { packet_id: packetId },
        },
      }];
      this.store.appendBatch(items);
      return { jobId };
    });
  }

  // ── 已公布阶段：暂缓 / 复核 / 更正（只追加） ─────────────────────

  placeHold({ packetId, reason, refId = null }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const packet = this.#mustPacket(state, packetId);
      if (!packet.sealedAt) throw new DomainError(ErrorCode.PRECONDITION, "未封卷包应直接完成重评，无需暂缓");
      this.store.appendBatch([{
        event: {
          event_type: "HOLD_PLACED",
          aggregate_type: "review_packet",
          aggregate_id: packetId,
          summary: `追加暂缓决定：${reason}`,
          payload: { reason, ref_id: refId },
        },
      }]);
      return { held: true };
    });
  }

  /** 替补重评后发布更正（旧封卷与旧名单均不重写）。 */
  issueCorrection({ packetId, reason, refId = null, basis = "", direct = false }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const packet = this.#mustPacket(state, packetId);
      if (!packet.sealedAt) throw new DomainError(ErrorCode.PRECONDITION, "包尚未完成初次封卷，不存在可更正对象");
      const { effective, excluded } = effectiveSheets(state, packet);
      if (effective.length === 0) throw new DomainError(ErrorCode.UNSEALED, "更正时没有有效评分");
      const supplemental = packet.supplementalRounds;
      if (!direct) {
        if (supplemental.length === 0) {
          throw new DomainError(ErrorCode.PRECONDITION, "尚未开启重评轮次，不能发布更正");
        }
        const lastRound = supplemental[supplemental.length - 1].round;
        if (!effective.some((s) => s.round === lastRound)) {
          throw new DomainError(ErrorCode.UNSEALED, `第 ${lastRound} 轮替补重评尚未提交，不能更正`);
        }
      }
      const result = aggregateResult(effective);
      const hash = computeEffectiveHash(effective);
      const previousResult = packet.sealedResult;
      const jobItems = [...state.sealJobs.values()]
        .filter((j) => j.packetId === packetId && j.completedAt === null)
        .map((job) => ({
          event: {
            event_type: "SEAL_JOB_COMPLETED",
            aggregate_type: "seal_job",
            aggregate_id: job.id,
            summary: `封卷作业完成：${job.id}`,
            payload: { packet_id: packetId },
          },
        }));
      this.store.appendBatch([{
        event: {
          event_type: "CORRECTION_ISSUED",
          aggregate_type: "review_packet",
          aggregate_id: packetId,
          summary: `追加更正决定：平均分 ${previousResult?.average ?? "?"} → ${result.average}（旧记录保留）`,
          payload: {
            reason,
            ref_id: refId,
            basis,
            previous_result: previousResult,
            result,
            effective_sheet_ids: effective.map((s) => s.id),
            excluded_sheet_ids: excluded.map(({ sheet: s, reason: r }) => ({ sheet_id: s.id, reason: r })),
            effective_hash: hash,
          },
        },
      }, ...jobItems]);
      return { corrected: true, previousResult, result, effectiveHash: hash };
    });
  }

  // ── 名单公布（快照，永不重写） ───────────────────────────────────

  publishList({ listId, stage, packetIds, quota }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      if (state.lists.has(listId)) throw new DomainError(ErrorCode.CONFLICT, `名单已存在：${listId}`);
      const rows = [];
      for (const packetId of packetIds) {
        const packet = this.#mustPacket(state, packetId);
        if (packet.stage !== stage) throw new DomainError(ErrorCode.VALIDATION, `评审包 ${packetId} 不属于阶段 ${stage}`);
        if (!packet.sealedAt) throw new DomainError(ErrorCode.PRECONDITION, `评审包 ${packetId} 尚未封卷`);
        if (packet.rescoreStatus === "pending_rescore") {
          throw new DomainError(ErrorCode.PRECONDITION, `评审包 ${packetId} 处于复核重评中，待更正决定后再公布`);
        }
        const held = packet.rescoreStatus === "held";
        const { effective } = effectiveSheets(state, packet);
        const result = aggregateResult(effective);
        rows.push({ packet_id: packetId, candidate_id: packet.entryId, average: result.average, held });
      }
      rows.sort((a, b) => b.average - a.average);
      const entries = rows.map((row, index) => ({
        ...row,
        rank: index + 1,
        result: !row.held && index < quota ? "advanced" : row.held ? "held" : "not_advanced",
      }));
      this.store.appendBatch([{
        event: {
          event_type: "LIST_PUBLISHED",
          aggregate_type: "stage_list",
          aggregate_id: listId,
          summary: `公布 ${stage} 阶段名单（${entries.length} 人，晋级 ${quota} 名；暂缓者不占晋级效力）`,
          payload: { stage, quota, entries },
        },
      }]);
      return { listId, entries };
    });
  }

  // ── 申诉：分批材料 + 法务/业务双签 + 跨阶段处置 ───────────────────

  fileAppeal({ appealId, candidateId, targetPacketId, targetStage, reason }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      if (state.appeals.has(appealId)) throw new DomainError(ErrorCode.CONFLICT, `申诉案件已存在：${appealId}`);
      const packet = state.packets.get(targetPacketId);
      if (!packet) throw new DomainError(ErrorCode.NOT_FOUND, `申诉所针对的评审包不存在：${targetPacketId}`);
      this.store.appendBatch([{
        event: {
          event_type: "APPEAL_FILED",
          aggregate_type: "appeal_case",
          aggregate_id: appealId,
          summary: `受理申诉：候选人 ${candidateId} 对 ${targetStage} 阶段结果提出申诉`,
          payload: {
            appeal_id: appealId,
            candidate_id: candidateId,
            target_packet_id: targetPacketId,
            target_stage: targetStage,
            reason,
          },
        },
      }]);
      return { appealId };
    });
  }

  /**
   * 申诉材料可分批到达。新材料在任一签署之后到达会使旧签署失效，
   * 因为签署人没有对完整案卷签过字——必须重新签署。
   */
  addAppealMaterial({ appealId, batchId, items, note }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const appeal = state.appeals.get(appealId);
      if (!appeal) throw new DomainError(ErrorCode.NOT_FOUND, `申诉案件不存在：${appealId}`);
      if (appeal.decidedAt) throw new DomainError(ErrorCode.CONFLICT, "申诉已裁决，不可再补材料");
      if (appeal.materials.some((m) => m.batchId === batchId)) {
        throw new DomainError(ErrorCode.CONFLICT, `材料批次已存在：${batchId}`);
      }
      const invalidatedSignatures = Object.keys(appeal.signatures);
      this.store.appendBatch([{
        event: {
          event_type: "APPEAL_MATERIAL_ADDED",
          aggregate_type: "appeal_case",
          aggregate_id: appealId,
          summary: `申诉材料批次 ${batchId} 到达（${(items ?? []).length} 项）${invalidatedSignatures.length ? "，此前签署需重签" : ""}`,
          payload: {
            batch_id: batchId,
            items: items ?? [],
            batch_hash: canonicalHash(items ?? []),
            note: note ?? "",
            invalidated_signatures: invalidatedSignatures,
          },
        },
      }]);
      return { appealId, batchId, materialCount: appeal.materials.length + 1, invalidatedSignatures };
    });
  }

  signAppeal({ appealId, role, signerId }) {
    if (!["legal", "business"].includes(role)) {
      throw new DomainError(ErrorCode.VALIDATION, "签署角色必须为 legal（法务）或 business（业务）");
    }
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const appeal = state.appeals.get(appealId);
      if (!appeal) throw new DomainError(ErrorCode.NOT_FOUND, `申诉案件不存在：${appealId}`);
      if (appeal.decidedAt) throw new DomainError(ErrorCode.CONFLICT, "申诉已裁决");
      if (appeal.materials.length === 0) throw new DomainError(ErrorCode.PRECONDITION, "尚无申诉材料，不能签署");
      const existing = appeal.signatures[role];
      if (existing && existing.signedMaterialCount === appeal.materials.length) {
        return { role, deduped: true, materialCount: appeal.materials.length };
      }
      this.store.appendBatch([{
        event: {
          event_type: "APPEAL_SIGNED",
          aggregate_type: "appeal_case",
          aggregate_id: appealId,
          summary: `${role === "legal" ? "法务" : "业务"}签署申诉裁决意见（基于 ${appeal.materials.length} 批材料）`,
          payload: { role, signer_id: signerId, signed_material_count: appeal.materials.length },
        },
      }]);
      return { role, deduped: false, materialCount: appeal.materials.length };
    });
  }

  /**
   * 裁决：必须同时持有法务与业务对"当前完整案卷"的签署。
   * action：
   * - uphold：驳回申诉，维持原结果；
   * - rescore：启动重评（未公布→追加复核，已公布→追加暂缓，下游阶段一并暂缓）；
   * - correction：材料足以直接认定时，指示秘书随后发布更正。
   */
  decideAppeal({ appealId, outcome, action, basis = "", stageOrder = [] }) {
    return this.store.withLocked(() => {
      const state = this.#snapshot();
      const appeal = state.appeals.get(appealId);
      if (!appeal) throw new DomainError(ErrorCode.NOT_FOUND, `申诉案件不存在：${appealId}`);
      if (appeal.decidedAt) throw new DomainError(ErrorCode.CONFLICT, "申诉已有裁决");
      const missing = ["legal", "business"].filter((role) => {
        const sig = appeal.signatures[role];
        return !sig || sig.signedMaterialCount !== appeal.materials.length;
      });
      if (missing.length > 0) {
        throw new DomainError(ErrorCode.PRECONDITION,
          `裁决需要法务与业务分别对完整案卷签署；缺失/失效签署：${missing.join(", ")}`,
          { missing, materialBatches: appeal.materials.length });
      }
      if (!["uphold", "rescore", "correction"].includes(action)) {
        throw new DomainError(ErrorCode.VALIDATION, "action 必须为 uphold | rescore | correction");
      }
      const materialHashes = appeal.materials.map((m) => canonicalHash(m.items));
      const target = state.packets.get(appeal.targetPacketId);
      const items = [{
        event: {
          event_type: "APPEAL_DECIDED",
          aggregate_type: "appeal_case",
          aggregate_id: appealId,
          summary: `申诉裁决：${outcome} / ${action}`,
          payload: {
            outcome,
            action,
            basis,
            material_hashes: materialHashes,
            effects: [],
          },
        },
      }];

      const effects = [];
      if (action === "rescore" && target) {
        const targetPublished = target.decisions.some((d) => d.kind === "published");
        if (!target.sealedAt) {
          // 极少见：封卷前申诉成立，直接开补充轮次。
          const round = target.supplementalRounds.length + 2;
          items.push(supplementalRoundEvent(target.id, round, `appeal:${appealId}`));
          effects.push({ packet_id: target.id, effect: "supplemental_round", round });
        } else if (!targetPublished) {
          items.push({
            event: {
              event_type: "REVIEW_ADDED",
              aggregate_type: "review_packet",
              aggregate_id: target.id,
              summary: `申诉成立：对未公布阶段追加复核决定`,
              payload: { reason: "appeal_upheld", ref_id: appealId, status: "pending_rescore" },
            },
          });
          effects.push({ packet_id: target.id, effect: "review" });
        } else {
          items.push(holdEvent(target.id, "appeal_upheld", appealId));
          effects.push({ packet_id: target.id, effect: "hold" });
        }
        // 跨阶段：该候选人在更后阶段的评审包/名单效力一并暂缓。
        if (stageOrder.length > 0) {
          const targetIdx = stageOrder.indexOf(appeal.targetStage);
          for (const packet of state.packets.values()) {
            if (packet.entryId !== target.entryId || packet.id === target.id) continue;
            const idx = stageOrder.indexOf(packet.stage);
            if (idx > targetIdx) {
              items.push(holdEvent(packet.id, `downstream_of_appeal:${appealId}`, appealId));
              effects.push({ packet_id: packet.id, effect: "downstream_hold", stage: packet.stage });
            }
          }
        }
        this.#enqueue(items, state, {
          channel: "secretary_queue",
          recipient: "committee_secretary",
          subject: `申诉 ${appealId} 裁决需重评：安排替补并发布复核/更正`,
          body: "旧名单不重写；替补盲视旧分重评后，以追加决定形式发布结果。",
          ref: { appeal_id: appealId, target_packet_id: target?.id },
          dedupKey: `appeal-decided:${appealId}`,
        });
      }
      // 把实际效果回写到 APPEAL_DECIDED 载荷（同批次内补全）。
      items[0].event.payload.effects = effects;
      this.store.appendBatch(items);
      return { appealId, action, effects };
    });
  }

  // ── 评委视角（替补盲视旧分的保证） ───────────────────────────────

  reviewerView(packetId, reviewerId) {
    const state = this.#snapshot();
    const packet = this.#mustPacket(state, packetId);
    const assignment = [...packet.assignments].reverse().find((a) => a.reviewerId === reviewerId);
    if (!assignment) throw new DomainError(ErrorCode.NOT_FOUND, "评委未被分配到该评审包");
    if (assignment.status === "recused") throw new DomainError(ErrorCode.PRECONDITION, "评委已回避");

    // 只返回该评委所在轮次、且由其本人提交的评分；其他评委与旧轮次分数一律不可见，
    // 也不返回任何聚合结果，保证替补在看不到旧分的情况下重评。
    const ownSheets = [...state.sheets.values()].filter(
      (s) => s.packetId === packetId && s.reviewerId === reviewerId && s.round === assignment.round,
    );
    return {
      packet_id: packetId,
      stage: packet.stage,
      review_token: packet.token,
      qual_version: packet.qualVersion,
      visible_fields: packet.visibleFields,
      exposed_materials: packet.exposedMaterials,
      round: assignment.round,
      role: assignment.role,
      scale_version_id: packet.scaleVersionId,
      own_scores: ownSheets.map((s) => ({
        sheet_id: s.id,
        round: s.round,
        values: s.status === "quarantined" ? null : redactValues(s),
        total: s.status === "quarantined" ? null : s.total,
        status: s.status,
        submitted_at: s.submittedAt,
      })),
      // 明确表达"不可见"：替补视图不携带任何旧分或他人分字段。
      other_scores_visible: false,
      prior_round_scores_visible: false,
      aggregate_visible: false,
    };
  }
}

function redactValues(sheet) {
  return sheet.values ?? null;
}

function holdEvent(packetId, reason, refId) {
  return {
    event: {
      event_type: "HOLD_PLACED",
      aggregate_type: "review_packet",
      aggregate_id: packetId,
      summary: `追加暂缓决定：${reason}`,
      payload: { reason, ref_id: refId },
    },
  };
}

function supplementalRoundEvent(packetId, round, refId) {
  return {
    event: {
      event_type: "SUPPLEMENTAL_ROUND_OPENED",
      aggregate_type: "review_packet",
      aggregate_id: packetId,
      summary: `申诉成立：开启第 ${round} 轮补充评审`,
      payload: { round, reason: "appeal_upheld", ref_id: refId },
    },
  };
}

function computeDefaultTotal(values) {
  const nums = Object.values(values).filter((v) => typeof v === "number");
  if (nums.length === 0) return 0;
  return Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(4));
}

/** 默认脱敏器：剥离 personal 与身份字段，仅保留白名单资格信息。 */
export function defaultRedactor({ qualification, materials, visibleFields }) {
  const allowed = new Set(visibleFields);
  const safeQualification = {};
  for (const [key, value] of Object.entries(qualification ?? {})) {
    if (allowed.has(key)) safeQualification[key] = value;
  }
  const safeMaterials = (materials ?? [])
    .filter((m) => !m.identifying)
    .map((m) => ({ material_id: m.material_id, type: m.type, hash: m.hash ?? canonicalHash(m) }));
  return {
    visibleFields: [...allowed],
    qualification: safeQualification,
    materials: safeMaterials,
  };
}
