import { createEventStore } from "../src/eventStore.js";
import { createReviewService } from "../src/service.js";

/** 默认合规人员名单：compliance-1。now 固定，测试用 at 显式指定业务时间。 */
export function makeService({ complianceOfficers = ["compliance-1"], now = "2026-09-20T09:00:00+08:00" } = {}) {
  const store = createEventStore();
  const service = createReviewService({ store, now: () => now, complianceOfficers });
  return { store, service };
}

export const MATERIALS = {
  identity: { name: "张三", id_number: "110101199001011234" },
  contact: { phone: "13800000000", email: "zhangsan@example.com" },
  work_samples: ["调查报道甲", "特写乙"],
  awards: ["年度新闻奖丙"],
};

export async function seedEntry(
  service,
  { entry_id = "entry-1", candidate_ref = "cand-A", qualification_version = 1, at = "2026-09-01T09:00:00+08:00" } = {},
) {
  await service.acceptEntry({ entry_id, candidate_ref, qualification_version, materials: MATERIALS, at });
}
