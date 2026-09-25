/** 记者选拔盲评封卷使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload?: Record<string, unknown>;
}

/** 事件一旦写入只追加；更正以后继事件表达，不原地改写。 */
export type DomainEventType =
  | "ENTRY_ACCEPTED"
  | "MATERIAL_VERSION_SUBMITTED"
  | "SCALE_VERSION_REGISTERED"
  | "REVIEW_PACKET_GENERATED"
  | "REVIEWER_ASSIGNED"
  | "CONFLICT_FLAGGED"
  | "CONFLICT_CONFIRMED"
  | "CONFLICT_DISMISSED"
  | "REVIEWER_RECUSED"
  | "AFFECTED_SCORE_ISOLATED"
  | "SUPPLEMENTAL_ROUND_OPENED"
  | "RECUSAL_FACT_DECLARED"
  | "SCORE_SUBMITTED"
  | "SCORE_EXCLUDED"
  | "SCORE_INVESTIGATION_OPENED"
  | "SCORE_INVESTIGATION_RESOLVED"
  | "PACKET_SEALED"
  | "HOLD_PLACED"
  | "REVIEW_ADDED"
  | "CORRECTION_ISSUED"
  | "LIST_PUBLISHED"
  | "SEAL_JOB_REQUESTED"
  | "SEAL_JOB_COMPLETED"
  | "APPEAL_FILED"
  | "APPEAL_MATERIAL_ADDED"
  | "APPEAL_SIGNED"
  | "APPEAL_DECIDED"
  | "OUTBOX_ENQUEUED"
  | "OUTBOX_DELIVERED";

export type AggregateType =
  | "candidate_entry"
  | "scale_version"
  | "review_packet"
  | "judging_assignment"
  | "score_sheet"
  | "recusal_fact"
  | "stage_list"
  | "seal_job"
  | "appeal_case"
  | "outbox_message";

/** 回避关系类别：任职 / 合作 / 指导。 */
export type RecusalKind = "employment" | "collaboration" | "supervision";

/** 已公布阶段的追加决定，均不重写旧名单。 */
export type AppendDecisionKind = "hold" | "review" | "correction";
