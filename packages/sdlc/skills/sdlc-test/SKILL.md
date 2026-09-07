---
name: sdlc-test
description: Verify code the right way. Use whenever code needs verification, a bug needs fixing, tests need writing, a build needs running, or the user says "test it / make sure it works / is it done". Mandates a feedback loop (agent checks its own work before the user sees it), red-green for bug fixes (write the failing test first, never edit the test to make it pass), and evals as regression protection for agent configuration. Distilled from Anthropic's AI-native SDLC playbook, adapted for pi.
---

# sdlc-test — 验证（反馈回路 + evals）

每个会话在人类看到之前先自验证，并修复自己的错误。验证是"完成"的一部分，不是事后动作。

## 适用场景

- 写完代码要确认能用
- 修 bug（必须先写失败测试）
- 写/跑测试、build、lint
- agent 配置（AGENTS.md/skills/hooks/模型）变更后确认行为不退化

## 流程

### Step 1 — 给 agent 一个反馈回路

- **测试命令封装成一条**：`make test` / `npm test`，失败退出非 0
- 在 `AGENTS.md` 的 Commands 区列命令 + **健康输出样子**（如 `All tests passed`）
- 设**可量化目标**，让你无需问用户就能自查：如 "test_status.py 全部通过"、"接口返回 200 带新字段"

### Step 2 — 修 bug：先写失败测试（red-green）

```
① 把 bug 复现成测试（复现步骤写成用例）
② 跑，确认按预期失败（red）
③ 提交这个测试
④ 修代码让它通过（green），不许改测试文件
```

- **禁止改测试文件来让测试通过**——修复前就存在、agent 无法改写的测试，才是 bug 消失的证明
- 如果工具/扩展层面能拦截（pi extensions `before_tool` 类事件），阻止修复任务中编辑测试文件；否则在 review 时拒绝任何碰测试文件的 diff

### Step 3 — 验证 = done 的一部分

- 报告完成前：跑 build/test/lint，**贴原始输出**
- 测试失败 → 修代码，不是修测试
- UI 类工作：用截图/浏览器工具对比 mock，实现→截图→对比→调整（2-3 轮）

### Step 4 — evals（配置回归保护）

agent 的行为由配置驱动（`AGENTS.md`、skills、hooks、模型、prompt），这些配置值得像代码一样做回归测试：

- 项目有 evals 套件时：**配置变更（AGENTS.md/skills/hooks/扩展代码）后必须跑相关 evals**，通过率下降 → 停下来 review 配置变更
- 定义 eval = 真实任务 prompt + 验收检查（命令断言/DB 检查/产物检查优先，LLM judge 兜底）
- **每个生产事故修复后，把复现写成一条 eval 留在套件里**（防再犯）

## 护栏

- 修复代码时不能削弱对代码的检查（禁止改测试/删失败测试）
- 确定性证据优先：测试输出、DB 状态、文件内容，而不是"看起来对了"

## 产物与审计

- 测试输出/截图随 PR 提交（reviewer 只审意图和风险）
- eval 结果存档（趋势可比对）

## 衡量

- agent 改动的一遍 CI 通过率
- 每 PR review 耗时（应随测试变好而下降）
- eval 套件通过率随时间
