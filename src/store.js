import {
  existsSync,
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  fsyncSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { DomainError, ErrorCode } from "./errors.js";

const lockBackoff = new Int32Array(new SharedArrayBuffer(4));

/**
 * 仅追加的 JSONL 事件存储。
 *
 * - 每个聚合（aggregate_type:aggregate_id）是一条独立流，version 从 1 递增。
 * - append 时携带 expectedVersion 实现乐观并发；落盘前重读文件，
 *   因此即使是同一文件上的两个存储实例，也能识别过期版本（并发封卷冲突）。
 * - 写入采用 O_EXCL 锁文件串行化并 fsync，进程中断后重启可通过重放恢复。
 */
export class EventStore {
  #path;
  #events = [];
  #streamCounts = new Map();
  #lockHeld = false;
  #listeners = new Set();
  #pendingNotify = [];

  constructor({ path = null, now = () => new Date().toISOString(), newId = () => randomUUID() } = {}) {
    this.#path = path;
    this.now = now;
    this.newId = newId;
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      this.#reloadFromFile();
    }
  }

  get path() {
    return this.#path;
  }

  #reloadFromFile() {
    if (!this.#path || !existsSync(this.#path)) return;
    const raw = readFileSync(this.#path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length < this.#events.length) {
      // 文件被截断或替换：以文件为准重建。
      this.#events = [];
      this.#streamCounts = new Map();
    }
    for (let i = this.#events.length; i < lines.length; i++) {
      const event = JSON.parse(lines[i]);
      this.#events.push(event);
      this.#bump(event);
    }
  }

  #bump(event) {
    const key = streamKey(event);
    this.#streamCounts.set(key, (this.#streamCounts.get(key) ?? 0) + 1);
  }

  #lockPath() {
    return `${this.#path}.lock`;
  }

  #acquireLock() {
    if (this.#lockHeld || !this.#path) return;
    const lockPath = this.#lockPath();
    for (let attempt = 0; attempt < 500; attempt++) {
      try {
        const fd = openSync(lockPath, "wx");
        closeSync(fd);
        this.#lockHeld = true;
        return;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        Atomics.wait(lockBackoff, 0, 0, 5 + attempt);
      }
    }
    throw new DomainError(ErrorCode.CONFLICT, "事件存储锁等待超时");
  }

  #releaseLock() {
    if (!this.#lockHeld || !this.#path) return;
    try {
      unlinkSync(this.#lockPath());
    } finally {
      this.#lockHeld = false;
    }
  }

  /**
   * 在跨实例互斥临界区内执行 fn：持锁后先从文件重读，
   * fn 内读取的状态与追加在同一临界区，并发封卷第二个进入者必然看到前者的结果。
   */
  withLocked(fn) {
    const nested = this.#lockHeld;
    this.#acquireLock();
    this.#reloadFromFile();
    try {
      return fn();
    } finally {
      if (!nested) {
        this.#releaseLock();
        const pending = this.#pendingNotify.splice(0);
        for (const e of pending) this.#notify(e);
      }
    }
  }

  /**
   * 以批次方式追加事件（同一把锁内顺序落盘，供工作流做跨聚合并发控制）。
   * 每项：{ event: {event_type, aggregate_type, aggregate_id, summary, payload}, expectedVersion }
   * 返回带 event_id / occurred_at / version 的已存储事件。
   */
  appendBatch(items) {
    const nested = this.#lockHeld;
    this.#acquireLock();
    this.#reloadFromFile();
    // 第一阶段：在写入前校验全部 expectedVersion，避免批次半途落盘后才冲突。
    const planned = [];
    for (const item of items) {
      const { event: draft, expectedVersion } = item;
      const key = streamKey(draft);
      const current = (this.#streamCounts.get(key) ?? 0) + planned.filter(
        (pl) => streamKey(pl.draft) === key,
      ).length;
      if (expectedVersion !== undefined && expectedVersion !== current) {
        if (!nested) this.#releaseLock();
        throw new DomainError(
          ErrorCode.VERSION_CONFLICT,
          `聚合 ${key} 版本冲突：期望基于 ${expectedVersion}，当前为 ${current}`,
          { aggregate: key, expectedVersion, currentVersion: current },
        );
      }
      const event = {
        event_id: draft.event_id ?? this.newId(),
        event_type: draft.event_type,
        aggregate_type: draft.aggregate_type,
        aggregate_id: draft.aggregate_id,
        occurred_at: draft.occurred_at ?? this.now(),
        version: current + 1,
        summary: draft.summary,
        payload: draft.payload ?? {},
      };
      planned.push({ draft: { ...draft }, event });
    }
    const stored = [];
    try {
      // 第二阶段：顺序落盘。
      for (const { event } of planned) {
        if (this.#path) {
          const fd = openSync(this.#path, "a");
          try {
            const buffer = Buffer.from(`${JSON.stringify(event)}\n`);
            let offset = 0;
            while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
        this.#events.push(event);
        this.#streamCounts.set(streamKey(event), event.version);
        stored.push(event);
        this.#pendingNotify.push(event);
      }
    } finally {
      if (!nested) {
        this.#releaseLock();
        const pending = this.#pendingNotify.splice(0);
        for (const e of pending) this.#notify(e);
      }
    }
    return stored;
  }

  append(event, expectedVersion) {
    return this.appendBatch([{ event, expectedVersion }])[0];
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* 监听器失败不影响存储 */
      }
    }
  }

  readAll() {
    return this.#events.slice();
  }

  readStream(aggregateType, aggregateId) {
    const key = `${aggregateType}:${aggregateId}`;
    return this.#events.filter((e) => streamKey(e) === key);
  }

  versionOf(aggregateType, aggregateId) {
    return this.#streamCounts.get(`${aggregateType}:${aggregateId}`) ?? 0;
  }

  static inMemory(options = {}) {
    return new EventStore({ path: null, ...options });
  }
}

export function streamKey(event) {
  return `${event.aggregate_type}:${event.aggregate_id}`;
}
