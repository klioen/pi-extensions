# Intent: Pi Web 本地管理台
Author: user. Status: accepted 2026-09-11.

## Problem
Pi 的历史会话、Skills、Extensions/Packages 和 pi-memory 数据分散在本地目录与设置文件中，缺少统一、直观且安全的可视化管理入口。

## Proposed outcome
提供可独立安装的 `pi-web` 包，通过 `/web` 启动仅监听 loopback 的本地 Web 管理台。V1 支持会话浏览、Skills 浏览与受控编辑、插件/包配置浏览、记忆浏览，以及 Control Deck 深浅色界面。

## Affected users and systems
- 本机使用 Pi 的开发者。
- Pi Session JSONL、全局/项目 Skills、settings.json、pi-memory Markdown 与日志。
- 根 umbrella package 新增 pi-web runtime extension。

## Constraints
- 默认仅监听 `127.0.0.1`，无需访问 token；通过严格 Host 与 same-origin 校验保护本地控制面。
- 浏览器不能提交任意文件路径；所有文件访问必须限制在允许根目录内。
- Session JSONL 默认只读浏览；仅允许通过受控 API 使用 Pi 原生 `session_info` 语义重命名，或经 revision 校验和二次确认删除已存储 session。Memory SQLite、raw_memories 和 rollout summaries 保持只读。
- V1 不在网页中聊天或切换当前运行中的 Pi session；当前运行 session 禁止删除。
- 使用 Node 内置模块与无构建 HTML/CSS/JS，保持零第三方 runtime dependency。
- Extension 长期资源从 `session_start` 启动并在 `session_shutdown` 清理。

## Open questions
- 后续版本是否增加活动会话 RPC、Package 安装/更新/删除和远程访问。
