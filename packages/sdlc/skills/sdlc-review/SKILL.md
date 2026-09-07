---
name: sdlc-review
description: Review PRs and code the right way. Use whenever the user asks to review a PR, review code, check a diff, do a code review, or says "review this". Runs three passes (bugs / security / compliance-against-spec), separates Important from nits, and feeds recurring mistakes back into AGENTS.md. Distilled from Anthropic's AI-native SDLC playbook, adapted for pi.
---

# sdlc-review — 代码审查（PR review）

审查双向进行：既审 incoming PR，也回应自己 PR 上的评论。工程师的注意力上移到"意图与风险"。

## 适用场景

- 审查 PR / diff / 代码
- 被要求 review 某次改动是否符合计划/规范
- 自己的改动收到 review 意见需要回应

## 流程

### Step 1 — 三遍式 review（REVIEW.md 风格）

每个 PR 跑三遍，每条 finding 标注 pass：

```
- Bugs:      逻辑错误、边界 case、隐性回归
- Security:  注入风险、认证缺口、PII 进日志
- Compliance: 改动是否匹配 spec.md / plan.md / 设计原则
```

- 有 `REVIEW.md` 就按它的 passes 和阈值执行；没有则用上面三遍
- 阅读上下文：`AGENTS.md`（约定）、`spec.md`/`plan.md`（如果存在）、diff

### Step 2 — 分级：Important vs Nit

- **Important**：会破坏行为、泄露数据、违反政策
- **Nit**：风格、命名、小问题
- **cap nits**：最多报 5 条 nit，其余汇总成计数（避免噪音淹没重点）
- 跳过：生成文件、CI 已强制的内容

### Step 3 — 输出 review 报告

```
## Review findings
### Bugs
- [Important] <文件:行> <问题>
### Security
- ...
### Compliance
- 与 spec.md/plan.md 一致 / 偏离点：...
Nits: <count>（列出前 5）
```

### Step 4 — 回应评论 / 修复循环

- 评论被 tag 到 agent 时：**响应并修复，push 修复**，PR 线程记录请求与变更
- 修复后重新验证（见 sdlc-test），直到 PR 只等 code owner 批准
- **机器审查不取代人工批准**：branch protection 仍需 code owner 审批，finding 只提供信息

### Step 5 — 反哺 `AGENTS.md`

- **review 抓到同一错误第二次 → 修正写进 `AGENTS.md`**
- review 也检查：改动是否让 `AGENTS.md` 过时了
- 因为 review 读 `AGENTS.md`，从下个 PR 起错误就被预防

## 产物与审计

- 审查政策（REVIEW.md）应用于所有 PR
- findings、fixes、评级、批准都记录在 PR 历史（PR 就是审计记录）
- 批准来自人类（branch protection），由 findings 提供信息

## 衡量

- 首审时间（目标：几分钟）
- 无需人类碰分支就解决的评论占比
- 合并前抓到的缺陷 vs 逃到生产的缺陷
