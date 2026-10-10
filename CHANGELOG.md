# Changelog — pi-worker

版本格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号声明在 `SKILL.md` 的 frontmatter `metadata.version`（锁内受管，
`skillset update pi-worker --apply` 落锁后 `sync` 部署）。

## [1.3.0] - 2026-10-10

- 长程施工、少交接：`wait` 默认只在完成汇报、停下提问、碰「不碰」清单、进程退出、疑似卡住时返回，里程碑汇报和越出「改」清单累积到返回时一起给；`--milestones` 恢复逐段返回。
- 去掉定时超时空醒：`wait` 默认不设时限，改为停滞检测（30 分钟无动静，有命令在跑时 90 分钟；`--stall` 可调）。
- SKILL：里程碑不向用户汇报，核算留到验收；改方案、计划或验收标准的停工须先问用户。

## [1.2.0] - 2026-10-10

- 新增 `start --adopt <会话.jsonl>`：接管别处起的 pi 会话（沿用上下文，施工单作为接管指示）。
- 自动加载安全底线扩展 `@yen/pi-auto-mode`（装了才加载）：危险命令、敏感文件与 `.env` 写入拦截，无人值守时 ask 即拒绝。

## [1.1.0] - 2026-10-10

- 改成子代理式结构：监工只收阶段性成果。`wait` 只在里程碑、完成汇报、停下提问、越界、退出时返回，输出本段改动文件、提醒和汇报原文；过程明细移到 `log`。去掉按改动次数的检查点。
- 施工单新增「阶段」；worker 每完成一阶段写 `## 里程碑 N` 汇报后直接继续，小事自行决定并记入「偏离」，只有影响方案的问题才以 `## 待定` 停下。
- 越界检查：piw 读施工单「改：」「不碰：」，worker 改到清单外的文件时立即提醒。
- 长任务底座：上下文到 70% 时 piw 自动压缩并附回施工单原文继续；瞬时服务/网络错误自动重试 3 次；新增 `resume` 在原会话上恢复退出的 worker；新增 `start --worktree` 在独立 worktree 和 `pi/<名>` 分支施工。两项自动化都不写 `~/.pi/agent/settings.json`。
- 审查集中到验收：四类偏差在完成汇报后完整过一遍，两轮返工不收敛就重派。

## [1.0.0] - 2026-10-10

- 首个版本：Claude 作监工，把已定方案交给本机 pi agent 施工（默认 `openai-codex/gpt-6.1-sol`、thinking `high`、`--fast`）。
- `scripts/piw.mjs`：把 pi RPC 模式包成常驻 worker，提供 start / wait（停下或每 N 次改动检查点）/ log / send（运行中插话、空闲时新一轮）/ abort / stop / list。
- `scripts/worker-ext.ts`：`--fast` 给 OpenAI 请求加 `service_tier: "priority"`；拦截 worker 的 git 写操作。
- `references/worker-rules.md`：注入 pi 系统提示的施工纪律（照单施工、最小改动、测试边界、汇报格式）。
- worker 以 `-nc` 启动，屏蔽 `~/.pi/agent` 全局说明，只补回项目链上的 AGENTS.md/CLAUDE.md。
