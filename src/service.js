import { EventStore } from "./store.js";
import { SealingWorkflow, defaultRedactor } from "./workflow.js";
import { Queries } from "./queries.js";
import { Outbox } from "./outbox.js";
import { reduce } from "./projection.js";
import { DomainError, ErrorCode } from "./errors.js";

/**
 * 组装盲评封卷服务：
 * - store：仅追加事件日志（文件或内存），崩溃后构造时自动重放；
 * - workflow：业务命令；queries：可解释查询；
 * - outbox：通知箱；resume()：系统中断后继续未封卷案件与未送达通知。
 */
export function createSealingService({ store = null, eventLogPath = null, deliver, now, newId, redactor } = {}) {
  const eventStore = store ?? new EventStore({ path: eventLogPath, now, newId });
  const workflow = new SealingWorkflow(eventStore, { redactor: redactor ?? defaultRedactor });
  const queries = new Queries(eventStore);
  const outbox = new Outbox(eventStore, { deliver });

  /**
   * 中断恢复：
   * 1. 事件日志在构造时已重放，未完成的封卷作业与未投递通知都可从状态中识别；
   * 2. 继续所有未完成封卷作业（幂等：已封卷的沿用原结果）；
   * 3. 投递通知箱中所有未送达消息（dedup 保证不重复外发）。
   */
  async function resume() {
    const stateBefore = reduce(eventStore.readAll());
    const pendingJobs = [...stateBefore.sealJobs.values()].filter((j) => j.completedAt === null);
    const sealed = [];
    for (const job of pendingJobs) {
      try {
        const result = workflow.sealPacket({ packetId: job.packetId });
        sealed.push({ job_id: job.id, packet_id: job.packetId, ...result });
      } catch (err) {
        if (err instanceof DomainError && [ErrorCode.UNSEALED, ErrorCode.PRECONDITION].includes(err.code)) {
          // 评分未齐/冲突未决：保留作业待下一次恢复，不做错误投递。
          sealed.push({ job_id: job.id, packet_id: job.packetId, deferred: true, reason: err.code });
        } else if (err instanceof DomainError && err.code === ErrorCode.NOT_FOUND) {
          sealed.push({ job_id: job.id, packet_id: job.packetId, deferred: true, reason: "NOT_FOUND" });
        } else {
          throw err;
        }
      }
    }
    const deliveries = await outbox.flushPending();
    return {
      resumed_at: eventStore.now(),
      seal_jobs: { total: pendingJobs.length, results: sealed },
      notifications: deliveries,
    };
  }

  /** 请求封卷并登记可恢复作业（异步入口）；随后可由 resume 完成。 */
  function requestSeal(args) {
    return workflow.requestSeal(args);
  }

  return { store: eventStore, workflow, queries, outbox, resume, requestSeal };
}

export { EventStore, SealingWorkflow, Queries, Outbox, DomainError, ErrorCode };
