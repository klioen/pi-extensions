# Plan: pi-lark 按需 Skill 模式（2026-09-11）

## Files that change

- `packages/lark/package.json`（新增）— 声明独立可安装的 `pi-lark` package。
- `packages/lark/extensions/lark.ts`（新增）— 注册 `/lark` 命令、维护会话级模式状态、动态过滤或恢复 `lark-*` Skill、显示状态栏，并处理 `/lark <请求>`。
- `packages/lark/lib/lark-core.cjs`（新增）— 放置可独立测试的参数解析、Skill 识别/过滤、状态归一化及模式提示构造逻辑。
- `packages/lark/lib/lark-core.d.cts`（新增）— core 的类型声明。
- `tests/lark-core.test.mjs`（新增）— 覆盖命令解析、名称匹配、过滤、持久化状态和提示内容。
- `package.json`（修改）— 将 `packages/lark/extensions` 加入 umbrella runtime extension 列表。
- `AGENTS.md`（修改）— 记录 `packages/lark` 的职责和新的根扩展加载顺序。

## Order of work

1. 先实现并测试纯函数 core：
   - `/lark` => 开启；
   - `/lark off` => 关闭；
   - `/lark status` => 查看；
   - `/lark <请求>` => 开启并把请求交给 agent；
   - 只匹配 Skill 名称 `lark-` 前缀，避免路径或描述误判。
2. 实现扩展：
   - 每个 session 默认关闭；
   - 使用 `pi.appendEntry("pi-lark-state", { enabled })` 持久化当前 session 状态；
   - `session_start` 从当前分支恢复最后状态并更新 `Lark: ON` 状态栏；
   - `before_agent_start` 在关闭时从 Pi 已构建的 system prompt 中移除名称以 `lark-` 开头的单个 `<skill>` XML block，开启时保留完整 prompt；
   - 每轮注入不可见的当前 Lark 模式说明，避免历史消息让模型误判当前状态；
   - `/lark <请求>` 在空闲状态下开启模式并通过 `pi.sendUserMessage()` 发起实际请求；忙碌时拒绝，避免命令处理与流式 turn 竞态。
3. 增加 package 元数据并接入根 umbrella extension，保持 `env` 第一，计划将 `lark` 放在 `plan` 后、`failover` 前。
4. 更新项目约定文档。
5. 跑完整 `npm test`，要求零失败；随后检查 `git diff` 和 `git status`。

## Risks

- **最危险的一步**：过滤 system prompt 时如果跨越 `<skill>` block 边界，会误删非 Lark Skill。因此 core 使用受单个 `</skill>` 边界约束的匹配，并以混合 Skill 列表做回归测试。
- Pi 当前公开类型包含 `BuildSystemPromptOptions`，但包根未导出 `buildSystemPrompt()`；直接导入 `dist/core` 又不在 package exports 契约内。因此不依赖内部模块，改为过滤稳定的 Agent Skills XML block。多个 `before_agent_start` 扩展仍按加载顺序串联，后续扩展可继续修改过滤后的 prompt。
- 这是提示词可见性控制，不是安全边界：关闭模式时，通用 `bash` 仍可能直接运行 `lark-cli`。第一版不拦截 shell，避免不可靠的命令字符串安全判断。
- `/skill:lark-*` 的显式调用由用户主动触发。第一版不拦截它，因为用户显式命令应保持可用；“默认屏蔽”仅指不向模型展示和不自动路由。如果产品要求严格只能经 `/lark`，可在后续加入 input gate。
- 放弃直接批量修改所有 Lark `SKILL.md` 的方案，因为那些文件不属于本仓库，而且无法让 `/lark` 在不 reload 的情况下恢复自动可见性。

## Proof

- `node --test tests/lark-core.test.mjs`
- `npm test`
- `git diff --check`
- 手工验证需在安装后 `/reload` 或重启 pi：
  1. 新 session 执行 `/lark status` 显示 disabled；普通 turn 的 Available Skills 不含 `lark-*`。
  2. `/lark` 后状态栏显示 `Lark: ON`，后续 turn 可见 `lark-*`。
  3. `/lark 查看今天日程` 会开启模式并发起对应 agent turn。
  4. `/lark off` 后后续 turn 再次隐藏 `lark-*`。
  5. `/new` 默认关闭；恢复原 session 时恢复该 session 最后的模式状态。
