import { createHash } from "node:crypto";

/** 领域错误：code 供调用方与测试断言，message 面向中文读者。 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/** 键序稳定的序列化，用于内容指纹。 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 内容指纹：评分、申诉批次等“同编号异内容”判断的依据。 */
export function canonicalHash(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

/**
 * 生效区间判断：[valid_from, valid_to] 双闭区间，valid_to 为 null 表示长期有效。
 * 时间一律按 ISO 字符串解析为毫秒比较，避免时区格式差异。
 */
export function inInterval(at, validFrom, validTo) {
  const t = Date.parse(at);
  const from = Date.parse(validFrom);
  if (Number.isNaN(t) || Number.isNaN(from)) {
    throw new DomainError("BAD_TIME", `无法解析时间：at=${at} from=${validFrom}`);
  }
  if (t < from) return false;
  if (validTo === null || validTo === undefined) return true;
  const to = Date.parse(validTo);
  if (Number.isNaN(to)) throw new DomainError("BAD_TIME", `无法解析时间：to=${validTo}`);
  return t <= to;
}

/** 脱敏键：评审包中不得出现的身份与联系方式字段。 */
const IDENTITY_KEYS = new Set([
  "identity",
  "contact",
  "personal",
  "name",
  "id_number",
  "phone",
  "email",
  "employer",
]);

/**
 * 由报名材料生成脱敏评审包内容：仅保留评审所需字段，
 * 返回被剔除字段清单供审计。
 */
export function redactMaterials(materials) {
  const content = {};
  const redacted = [];
  for (const [key, value] of Object.entries(materials ?? {})) {
    if (IDENTITY_KEYS.has(key)) redacted.push(key);
    else content[key] = structuredClone(value);
  }
  redacted.sort();
  return { content, redacted_fields: redacted };
}
