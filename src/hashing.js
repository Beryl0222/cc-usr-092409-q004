import { createHash } from "node:crypto";

/**
 * 规范化哈希：对相同语义内容（与键顺序无关）产生稳定摘要，
 * 用于评分去重、同编号异内容检测与证据指纹。
 */
export function canonicalHash(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
  return `{${entries.join(",")}}`;
}

/** 生成证据指纹（排序后哈希，证据以哈希列表提交）。 */
export function evidenceFingerprint(evidenceHashes) {
  return canonicalHash([...evidenceHashes].sort());
}
