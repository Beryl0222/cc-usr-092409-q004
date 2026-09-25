import { DomainError, ErrorCode } from "./errors.js";
import { reduce } from "./projection.js";

/**
 * 通知箱：所有外发通知先作为 OUTBOX_ENQUEUED 事件入日志（与业务决定同一事务批次），
 * 再由投递器异步/可重覆地投递。进程中断后，重建状态即可继续未投递消息；
 * 同一 dedup_key 只入箱一次，投递成功记录 OUTBOX_DELIVERED，重放不重复外发。
 */
export class Outbox {
  constructor(store, { deliver } = {}) {
    this.store = store;
    this.deliver = deliver ?? (async () => {});
    this.state = reduce(store.readAll());
    store.subscribe((event) => {
      reduce([event], this.state);
    });
  }

  /** 投递所有未送达消息；任一失败不影响其他消息，下次调用继续。 */
  async flushPending() {
    const results = [];
    for (const message of [...this.state.outbox.values()].filter((m) => m.deliveredAt === null)) {
      try {
        await this.deliver(message);
      } catch (err) {
        results.push({ id: message.id, ok: false, error: err });
        continue;
      }
      // expectedVersion 防止并发重复确认；已被其他实例确认则忽略。
      try {
        this.store.append(
          {
            event_type: "OUTBOX_DELIVERED",
            aggregate_type: "outbox_message",
            aggregate_id: message.id,
            summary: `通知已投递：${message.subject}`,
            payload: { dedup_key: message.dedupKey },
          },
          1,
        );
        results.push({ id: message.id, ok: true });
      } catch (err) {
        if (err instanceof DomainError && err.code === ErrorCode.VERSION_CONFLICT) {
          results.push({ id: message.id, ok: true, deduped: true });
        } else {
          throw err;
        }
      }
    }
    return results;
  }

  pending() {
    return [...this.state.outbox.values()].filter((m) => m.deliveredAt === null);
  }
}
