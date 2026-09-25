/** 记者选拔回避与复核使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
}

/** 回避关系类型：任职、合作、指导。 */
export type RelationType = "employment" | "collaboration" | "mentorship";

/** 评分表状态：锁定有效 / 回避隔离 / 异内容调查中（原结果继续有效）。 */
export type SheetStatus = "locked" | "quarantined" | "under_investigation";

/** 追加决定类型：暂缓、复核、更正。 */
export type DecisionKind = "hold" | "review" | "correction";

/** 申诉裁决结果：维持、复核、更正。 */
export type AppealOutcome = "uphold" | "remand" | "correct";

/** 申诉签署角色：法务与业务分别签署，一致后方可裁决。 */
export type SignoffRole = "legal" | "business";

/** 回避事实：关系带有生效区间，valid_to 为 null 表示长期有效。 */
export interface RecusalDeclared extends DomainEvent {
  event_type: "RECUSAL_DECLARED";
  aggregate_type: "recusal_fact";
  judge_id: string;
  candidate_ref: string;
  relation_type: RelationType;
  valid_from: string;
  valid_to: string | null;
}

/** 评分提交即锁定量表版本与证据；content_hash 用于识别“同编号异内容”。 */
export interface ScoreSubmitted extends DomainEvent {
  event_type: "SCORE_SUBMITTED";
  aggregate_type: "score_sheet";
  assignment_id: string;
  entry_id: string;
  judge_id: string;
  stage: string;
  rubric_version: string;
  criteria: Array<{ name: string; score: number }>;
  evidence_refs: string[];
  content_hash: string;
  sheet_version: number;
}

/** 回避隔离：只影响生效区间内的评分，记录来源冲突与回避事实。 */
export interface ScoreQuarantined extends DomainEvent {
  event_type: "SCORE_QUARANTINED";
  aggregate_type: "score_sheet";
  conflict_id: string;
  recusal_id: string;
  reason: "recusal_confirmed";
}

/** 已公布阶段不可改写，只能追加暂缓/复核/更正决定。 */
export interface DecisionAppended extends DomainEvent {
  event_type: "DECISION_APPENDED";
  aggregate_type: "stage_list";
  entry_id: string;
  kind: DecisionKind;
  corrected_to: "advanced" | "not_advanced" | null;
  rationale: string;
  source: "committee" | "appeal";
  appeal_id: string | null;
}

/** 申诉裁决：法务与业务签署一致后生效。 */
export interface AppealRuled extends DomainEvent {
  event_type: "APPEAL_RULED";
  aggregate_type: "appeal_case";
  outcome: AppealOutcome;
  corrected_to: "advanced" | "not_advanced" | null;
}

/** 封卷：乐观并发控制，并发封卷只有一笔成功。 */
export interface CaseSealed extends DomainEvent {
  event_type: "CASE_SEALED";
  aggregate_type: "selection_case";
  final_status: string;
}
