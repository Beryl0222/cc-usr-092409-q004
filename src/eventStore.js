import { DomainError } from "./domain.js";

/**
 * 追加式事件库。
 *
 * - 事件一旦写入即冻结，不允许原地改写；业务更正只能追加后继事件。
 * - 每个聚合（aggregate_type + aggregate_id）维护单调递增的 version，
 *   写入时校验 version === 当前版本 + 1，作为乐观并发控制：
 *   并发封卷等场景下，后到的写入会得到 VERSION_CONFLICT。
 * - 写入经内部队列串行化，保证“检查版本 + 落库”是原子的。
 */
export function createEventStore() {
  const events = [];
  const versions = new Map();
  let queue = Promise.resolve();

  const keyOf = (aggregateType, aggregateId) => `${aggregateType}:${aggregateId}`;

  function append(event) {
    const run = () => {
      const key = keyOf(event.aggregate_type, event.aggregate_id);
      const current = versions.get(key) ?? 0;
      if (event.version !== current + 1) {
        throw new DomainError(
          "VERSION_CONFLICT",
          `聚合 ${key} 期望版本 ${current + 1}，收到 ${event.version}（并发写入或状态过期）`,
        );
      }
      const stored = Object.freeze({ ...event, seq: events.length + 1 });
      events.push(stored);
      versions.set(key, event.version);
      return stored;
    };
    const pending = queue.then(run);
    // 失败不阻断后续写入队列
    queue = pending.catch(() => {});
    return pending;
  }

  return {
    append,
    all: () => [...events],
    size: () => events.length,
    versionOf: (aggregateType, aggregateId) => versions.get(keyOf(aggregateType, aggregateId)) ?? 0,
  };
}
