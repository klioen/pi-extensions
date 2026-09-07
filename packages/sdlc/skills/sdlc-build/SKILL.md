---
name: sdlc-build
description: >-
  Implement code the right way. Use whenever the user asks to implement something, write code, change
  code, fix code, add a feature, or start development work. Mandates: read-only reconnaissance first,
  a written plan.md approved before any edit, AGENTS.md as the project-memory file (never CLAUDE.md),
  and guardrails that run as code. Distilled from Anthropic's AI-native SDLC playbook, adapted for pi.
---

# sdlc-build — 实现（代码开发规范）

没有获批的计划不动手。制度知识变成 agent 每会话读取的文件（`AGENTS.md`），护栏用代码运行而不是靠习惯。

## 适用场景

- 实现新功能/写代码/改代码/修 bug/重构
- 任何会修改文件或执行命令的开发工作

## 流程

### Step 0 — 读项目记忆 `AGENTS.md`

- 每次会话开始先读仓库根的 `AGENTS.md`（约定、命令、架构、常见错误）
- **项目记忆文件是 `AGENTS.md`，不是 CLAUDE.md**
- 没有 `AGENTS.md` 时：向用户提议用 `/init` 等价方式生成初稿（build 命令、test 命令、lint 命令、约定、常见错误），保持一页以内

### Step 1 — 只读勘察（plan mode 等价）

**在写任何代码之前，先只读勘察：**

- 用 `read`/`grep`/`ls` 读代码，**禁止 edit/write**（除非用户明确先要你直接改）
- 理解现状：相关文件、调用链、测试、约定

### Step 2 — 产出 `plan.md` 并获批

写出实现计划，包含：

```
# Plan: <标题>（from spec.md/intent.md <日期>）

## Files that change
<改动文件列表（新增/修改）>

## Order of work
<1. ... 2. ... 3. ...>

## Risks
<可能破坏什么、最危险的一步、放弃的替代方案>

## Proof
<哪些测试/命令证明完成>
```

- 问自己并写进 plan：这个改动可能破坏什么？哪步最危险？为什么不做别的方案？
- **把 plan 给用户确认**。plan 要详尽到"没看过对话的人也能照着实现"
- 批准后提交 `plan.md` 进 git（审计链）

### Step 3 — 实现

- 按 plan 实现。计划好时通常一遍过
- **偏离 plan 时：同一 commit 里更新 `plan.md`**（保持同步）
- 涉及多文件独立任务时：可用 pi-subagents 的 `spawn_agent` 并行（各用 git worktree 隔离），你负责编排和 review

### Step 4 — 自验证（衔接 sdlc-test）

- 实现完必须跑测试/build/lint（见 sdlc-test），贴输出
- 验证通过才算 done

### Step 5 — 维护 `AGENTS.md`

- **同一错误出现两次 → 修正写进 `AGENTS.md`**（"Things pi gets wrong" 区）
- 保持一页以内（stale 内容浪费上下文）

## 护栏（guardrails as code）

- 保护路径（生成类/冻结包）不直接改，改走受控流程
- 不改依赖版本除非用户要求（平台团队负责时）
- 凭据不进 diff（.env 等不入库）

## 产物与审计

- `plan.md` 与代码同 commit 或先行提交；实现偏离时同步更新
- 改动 diff + 测试随 PR（review 见 sdlc-review）
- 提交链 = 审计链（谁批准 plan、agent 产出什么）
