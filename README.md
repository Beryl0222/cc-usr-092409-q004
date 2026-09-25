# 记者选拔盲评回避与申诉封卷

本仓库实现记者人才选拔的**盲评封卷**领域服务：报名材料按资格版本生成脱敏评审包；评委的任职/合作/指导关系以带生效区间的事实登记；分配前自动提示冲突并由独立合规人员确认；迟报关系只隔离受影响评分，由替补评委盲视重评；已公布阶段不重写旧名单，只追加暂缓、复核或更正决定；申诉材料分批到达，裁决须法务与业务分别签署。

## 设计原则

- **只追加事件溯源**：所有业务结果都是领域事件，写入仅追加的 JSONL 日志；标识、发生时间与版本永不原地改写，更正产生后继事件（`HOLD_PLACED` / `REVIEW_ADDED` / `CORRECTION_ISSUED`）。
- **审计不删除**：被隔离的评分保留原始 `SCORE_SUBMITTED` 事件，追加 `SCORE_EXCLUDED` 与 `AFFECTED_SCORE_ISOLATED` 说明排除原因。
- **同一事务落盘**：业务决定与其触发的通知（`OUTBOX_ENQUEUED`）在同一事件批次追加；崩溃恢复只需重放日志。
- **最小知情**：评审包只含白名单资格字段与非身份材料；评委视图只含本人当轮评分，替补评委**看不到旧分、他人分与聚合分**。

## 模块结构

| 文件 | 职责 |
| --- | --- |
| `src/store.js` | 仅追加 JSONL 事件存储：聚合版本号、写入前全量预检的原子批次、O_EXCL 跨实例锁、fsync、重放恢复 |
| `src/projection.js` | 纯函数事件归约器：事件日志 → 当前状态；有效/排除评分口径、结果聚合 |
| `src/workflow.js` | 全部业务命令：报名版本、脱敏评审包、回避事实与冲突提示/合规确认、迟报处置、替补重评、评分幂等与调查、封卷、暂缓/复核/更正、名单、申诉 |
| `src/outbox.js` | 通知箱：未送达消息可重放、可重试，dedup_key 幂等 |
| `src/queries.js` | 可解释查询：候选人逐阶段的有效评分、排除原因、决定变化时间线 |
| `src/service.js` | 门面组装与 `resume()`：中断后继续未封卷作业与未送达通知 |
| `src/hashing.js` | 规范化哈希（键序无关）：内容指纹、证据指纹、快照哈希 |
| `src/errors.js` | 机器可读错误码（版本冲突、前置条件、已封卷等） |
| `contracts/domain.schema.json` | 领域事件类型与聚合类型契约 |

## 关键流程

1. **报名与评审包**：`acceptEntry` → `submitMaterialVersion`（版本连续、旧版保留）→ `generateReviewPacket` 按指定资格版本生成脱敏快照，锁定量表版本。
2. **分配与回避**：`declareRecusalFact`（任职 `employment` / 合作 `collaboration` / 指导 `supervision`，含生效区间）→ `assignReviewer` 自动提示区间重叠冲突 → 合规人员 `confirmConflict` / `dismissConflict`。
3. **迟报关系**：`declareLateRecusal` 仅隔离该评委对该候选人的评分；未封卷开补充轮，已封卷未公布追加复核，已公布追加暂缓。替补经 `openSupplementalRound` / `openRescoreRound` 指派，同样经过冲突检测。
4. **评分**：`submitScore` 锁定量表版本、评分细则哈希与证据指纹；完全相同重传沿用原结果（零新事件）；同编号异内容自动 `SCORE_INVESTIGATION_OPENED` 隔离调查。
5. **封卷与更正**：`sealPacket` 支持 `expectedVersion` 乐观并发；已封卷重复请求幂等。重评后以 `issueCorrection` 追加更正，旧封卷与旧名单均保留。
6. **申诉**：材料 `addAppealMaterial` 可分批到达；新材料使既有签署失效，法务与业务须分别对完整案卷重签，`decideAppeal` 才可裁决，并可对下游阶段追加暂缓。
7. **中断恢复**：文件存储重开即重放；`resume()` 继续未完成的封卷作业（评分未齐则暂缓待下次）并投递通知箱滞留消息。

## 查询解释

`queries.explainCandidate(candidateId)` 按候选人返回每个阶段：

- `effective_scores`：计入结果的评分（评委、轮次、量表版本、证据、哈希）；
- `excluded_scores`：被排除的评分及原因（`late_declared_fact` / `conflict_confirmed` / `investigation_rejected` 等）；
- `decision_timeline`：封卷 → 公布 → 暂缓/复核 → 更正的完整变化链，旧决定不消失；
- `appeals`：分批材料、双签状态与裁决效果。

## 本地检查

```bash
npm test     # node:test，33 个用例
npm run build
```

## 领域边界

事件一旦被接收，其标识、发生时间和版本不应被原地改写；业务更正产生后继记录。涉及个人、机构或商业敏感信息时，调用方只读取完成职责所必需的字段。
