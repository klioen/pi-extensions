# Plan: 严格对齐 Codex Memory Phase 1 / Phase 2 / Recall P0（approved 2026-09-10）

## Files that change
- 保留 `packages/memory/prompts/phase_one_system.md` 与 `consolidation.md`：Phase 1/2 prompt 副本。
- 新增 `packages/memory/prompts/read_path.md`：Codex recall developer-policy prompt 原样副本。
- 修改 `packages/memory/lib/memory-core.cjs` 与 `.d.cts`：增加 recall prompt 渲染、2,500-token 头部截断、memory citation 提取/剥离、完整 session ID usage 更新等可测试纯逻辑。
- 修改 `packages/memory/extensions/memory.ts`：通过 `before_agent_start.systemPrompt` 动态注入 recall，不再写持久化 custom/user message；在最终 assistant message 上剥离 citation 并更新 usage。
- 修改 `tests/memory-core.test.mjs`：覆盖模板一致性、summary 截断、system prompt 拼接、citation 解析/剥离、完整 ID 去重与 usage 更新。
- 保留当前 Phase 1/2 默认 `traex/DeepSeek-V4-Flash`、provider-only 加载、workspace diff、heartbeat、artifact validation 和 worker.log ignore。

## Order of work
1. 原样同步 Codex `read_path.md` 到发布包，渲染 `base_path` 与截断后的 `memory_summary`。
2. 将 recall 默认摘要预算从 4,000 改为 Codex 的 2,500 tokens，并使用 pi 的保守 `ceil(chars/4)` 语义做安全头部截断。
3. `before_agent_start` 返回链式 `systemPrompt`，不再返回持久化 custom message。
4. 实现 `<oai-mem-citation>` 解析和从 assistant 可见文本剥离；兼容 `<thread_ids>`，只接受完整 UUID session ID。
5. 在 `message_end` 处理最终 assistant 文本，按 citation rollout IDs 精确更新 `phase1_outputs.usage_count/last_usage`，不再以 read-start 或 8 位前缀作为 retention usage。
6. 增加单测，运行完整测试、prompt 字节一致性和 diff 检查。

## Risks
- pi 没有 Codex 独立 developer-policy slot；使用 `before_agent_start` 的链式 system prompt 是 pi 可提供的最高优先级等价机制。
- 修改 finalized assistant message 必须保留 role、usage、provider、tool calls 等所有其他字段，只替换 text content。
- Citation 可能跨多个 text block；解析时需要合并识别，同时避免破坏 thinking/toolCall 内容。
- citation 中无合法完整 UUID 时仍剥离标记，但不更新任何 phase1 usage，避免模糊前缀误计数。

## Proof
- `cmp packages/memory/prompts/read_path.md ~/ai/codex/codex-rs/ext/memories/templates/memories/read_path.md`
- `npm test`
- `git diff --check`
- 隔离 pi 运行确认 recall 位于 system prompt、最终可见回复不含 `<oai-mem-citation>`，且 DB 只更新 citation 中的完整 session ID。
