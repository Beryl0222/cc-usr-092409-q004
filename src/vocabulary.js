/**
 * 领域词汇表：事件类型与聚合类型的唯一权威来源。
 * contracts/domain.schema.json 中的枚举必须与此保持一致（由契约测试保证）。
 */

export const EVENT_TYPES = [
  // 报名与评审包
  "ENTRY_ACCEPTED",
  "ENTRY_REVISED",
  "REVIEW_PACKAGE_GENERATED",
  // 回避事实与冲突
  "RECUSAL_DECLARED",
  "CONFLICT_FLAGGED",
  "CONFLICT_DISMISSED",
  "INCIDENT_CONFIRMED",
  // 分配与替补
  "ASSIGNMENT_PROPOSED",
  "ASSIGNMENT_ACTIVATED",
  "ASSIGNMENT_REPLACED",
  // 评分
  "SCORE_SUBMITTED",
  "SCORE_RESUBMISSION_REUSED",
  "INVESTIGATION_OPENED",
  "INVESTIGATION_RESOLVED",
  "SCORE_QUARANTINED",
  // 阶段名单与追加决定
  "STAGE_LIST_PUBLISHED",
  "DECISION_APPENDED",
  // 申诉
  "APPEAL_OPENED",
  "APPEAL_MATERIAL_RECEIVED",
  "APPEAL_SIGNOFF_RECORDED",
  "APPEAL_RULED",
  // 封卷与通知
  "CASE_SEALED",
  "NOTIFICATION_QUEUED",
  "NOTIFICATION_SENT",
  "DECISION_FINALIZED",
];

export const AGGREGATE_TYPES = [
  "candidate_entry",
  "judging_assignment",
  "score_sheet",
  "appeal_case",
  "recusal_fact",
  "stage_list",
  "selection_case",
];

/** 回避关系类型：任职、合作、指导。 */
export const RELATION_TYPES = ["employment", "collaboration", "mentorship"];

/** 追加决定类型：暂缓、复核、更正。 */
export const DECISION_KINDS = ["hold", "review", "correction"];

/** 申诉裁决结果：维持、复核、更正。 */
export const APPEAL_OUTCOMES = ["uphold", "remand", "correct"];

/** 申诉签署角色：法务与业务分别签署。 */
export const SIGNOFF_ROLES = ["legal", "business"];
