# pi-worker

把已定方案交给本机 pi coding agent 施工，由监工派单、通信、纠偏和验收。
`piw` 通过 pi 的 RPC 模式维护后台 worker，支持阶段汇报、请示、自动压缩与重试、独立 worktree 和用量统计。
完整的派单与验收流程见 [SKILL.md](skills/pi-worker/SKILL.md)。

## 环境

- Node.js、Git，以及已安装并登录的 `@earendil-works/pi-coding-agent`。
- `piw` 默认从全局 npm 安装定位 pi；其他安装方式可设置 `PIW_PI_CLI` 为 pi 的 `cli.js` 绝对路径。
- Windows 的 worktree 删除检查与集成测试使用 PowerShell 7（`pwsh`）。
- 可选安全扩展 `@yen/pi-auto-mode`：已通过 pi 安装时，worker 会自动加载。

## 安装

本库是一个 Agent Skill，不需要构建或在本库安装 npm 依赖。`worker-ext.ts` 由 pi 加载。

```sh
git clone ssh://git@dxp4800plus-bd8.tail23d75b.ts.net:222/Yen/pi-worker.git
cd pi-worker
node skills/pi-worker/scripts/piw.mjs
```

让 Claude Code / Codex 发现技能时，将 `skills/pi-worker/` 复制到对应技能目录。
以下为首次安装到共享的 `~/.agents/skills/`：

```powershell
$skillRoot = Join-Path $HOME '.agents/skills'
New-Item -ItemType Directory -Path $skillRoot -Force | Out-Null
Copy-Item -LiteralPath .\skills\pi-worker -Destination $skillRoot -Recurse
```

```sh
mkdir -p ~/.agents/skills
cp -R skills/pi-worker ~/.agents/skills/
```

Claude Code 的 `~/.claude/skills` 可由 `my-skills` 的 `skillset bootstrap` 链接到共享目录。
已由 `my-skills` 管理的安装副本继续使用锁文件：本库的 `skills/pi-worker/` 是上游 bundle，
`skillset update pi-worker --apply` 固定新提交和内容哈希，`skillset sync pi-worker` 安装。

## 使用

先按 [SKILL.md](skills/pi-worker/SKILL.md) 写好施工单，再派单：

```sh
node skills/pi-worker/scripts/piw.mjs start demo --brief /absolute/path/brief.md --cwd /absolute/path/project --worktree
node skills/pi-worker/scripts/piw.mjs wait demo
node skills/pi-worker/scripts/piw.mjs send demo "纠正内容"
node skills/pi-worker/scripts/piw.mjs stats demo
node skills/pi-worker/scripts/piw.mjs stop demo
```

默认运行目录为 `~/.claude/pi-worker/`，可通过 `PIW_HOME` 指定。
worker 的完工报告仍需监工验收；Git 提交与 worktree 清理由监工完成。

## 验证

```sh
node --check skills/pi-worker/scripts/piw.mjs
node skills/pi-worker/scripts/piw.mjs
```

Windows 上运行现有 worktree 检查集成测试（包含 junction、隐藏目录和读取失败）：

```powershell
pwsh -NoProfile -File tests/worktree-guard.ps1 -ScratchRoot (Join-Path $env:TEMP 'pi-worker-tests')
```

## 维护

技能版本以 `SKILL.md` 的 `metadata.version` 为准，变更记录见 [CHANGELOG.md](skills/pi-worker/CHANGELOG.md)。
更新技能时同步版本与变更记录，验证后提交；消费方按 Git 提交和 bundle 哈希固定版本。
`.gitattributes` 保留 bundle 的原始字节，确保 Windows / Linux 拉取后内容哈希一致。

本库从 `Yen/my-skills` 的 `skillset/authored/pi-worker/` 拆出，保留原有 12 个技能提交；
首次独立提交包含尚未提交的 1.7.3 更新和原有 Windows 测试。原仓库保留上游登记与安装锁。

MIT License，见 [LICENSE](LICENSE)。
