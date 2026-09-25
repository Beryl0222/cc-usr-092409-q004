/** 领域错误：携带机器可读 code，便于调用方区分冲突与普通失败。 */
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export const ErrorCode = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  CONFLICT: "CONFLICT",
  UNSEALED: "UNSEALED",
  ALREADY_SEALED: "ALREADY_SEALED",
  PANEL_FROZEN: "PANEL_FROZEN",
  CONTENT_MISMATCH: "CONTENT_MISMATCH",
  VALIDATION: "VALIDATION",
  PRECONDITION: "PRECONDITION",
});
