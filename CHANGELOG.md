# Changelog — pi-worker

版本格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号声明在 `SKILL.md` 的 frontmatter `metadata.version`（锁内受管，
`skillset update pi-worker --apply` 落锁后 `sync` 部署）。

## [1.0.0] - 2026-10-10

- 首个版本：Claude 作监工，把已定方案交给本机 pi agent 施工（默认 `openai-codex/gpt-6.1-sol`、thinking `high`、`--fast`）。
- `scripts/piw.mjs`：把 pi RPC 模式包成常驻 worker，提供 start / wait（停下或每 N 次改动检查点）/ log / send（运行中插话、空闲时新一轮）/ abort / stop / list。
- `scripts/worker-ext.ts`：`--fast` 给 OpenAI 请求加 `service_tier: "priority"`；拦截 worker 的 git 写操作。
- `references/worker-rules.md`：注入 pi 系统提示的施工纪律（照单施工、最小改动、测试边界、汇报格式）。
- worker 以 `-nc` 启动，屏蔽 `~/.pi/agent` 全局说明，只补回项目链上的 AGENTS.md/CLAUDE.md。
