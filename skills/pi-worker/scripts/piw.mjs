#!/usr/bin/env node
// piw：把 pi 的 RPC 模式包成"施工 worker"。每个 worker 一个常驻后台进程，
// 监工经由运行目录里的 inbox/、events.jsonl、status.json 与它往来。
// 监工默认只收阶段性成果（里程碑、完成汇报、提问、越界提醒）；过程细节在 log 里。
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.dirname(HERE);
const RUNS = process.env.PIW_HOME || path.join(os.homedir(), ".claude", "pi-worker");
const WIN = process.platform === "win32";

const DEFAULTS = { model: "openai-codex/gpt-6.1-sol", thinking: "high", fast: true };
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const CHANGE_TOOLS = new Set(["edit", "write"]);
// worker-ext 提供的汇报工具：调用即结构化成果，不再从标题猜
const REPORT_TOOLS = { stage_report: "milestone", final_report: "report", ask_supervisor: "ask" };
// 用户的 pi 全局设置关掉了自动压缩和重试，RPC 开关又会写回全局设置，所以这两件事由 piw 自己做。
const COMPACT_AT = 0.7;
// 退避按代理或网络断一阵来定：30s、1m、2m、4m，合计能扛约 8 分钟
const RETRY_DELAYS = [30, 60, 120, 240];
const TRANSIENT = /overload|rate.?limit|429|5\d\d|timeout|timed out|ECONN|ETIMEDOUT|socket|network|fetch failed|terminated|stream/i;
const COMPACT_INSTRUCTIONS =
	"保留：施工单的目标、范围与阶段划分；已完成的里程碑及其汇报；改过的文件清单；监工的全部插话与纠正；当前进行中的步骤、已知问题和下一步。";

// ---------- 通用 ----------

function die(msg) {
	console.error(`piw: ${msg}`);
	process.exit(1);
}

function parseArgs(argv) {
	const pos = [];
	const opt = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) {
			pos.push(a);
			continue;
		}
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) opt[key] = true;
		else {
			opt[key] = next;
			i++;
		}
	}
	return { pos, opt };
}

const runDir = (name) => path.join(RUNS, name);
const readJson = (file, fallback) => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
};
function writeJson(file, value) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
	fs.renameSync(tmp, file);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => {
	s = String(s ?? "").replace(/\s+/g, " ").trim();
	return s.length > n ? `${s.slice(0, n)}…` : s;
};
const tail = (s, n) => {
	s = String(s ?? "").trim();
	return s.length > n ? `…${s.slice(-n)}` : s;
};
// 守护进程脱离终端运行，没有控制台；子进程不加 windowsHide 时 Windows 会给它新开一个控制台窗口
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...opts });
const git = (cwd, ...args) => run("git", ["-C", cwd, ...args]).trim();

function requireRun(name) {
	if (!name) die("缺少 worker 名");
	const dir = runDir(name);
	if (!fs.existsSync(path.join(dir, "meta.json"))) die(`没有名为 ${name} 的 worker（${dir}）`);
	return dir;
}

function alive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function status(dir) {
	const st = readJson(path.join(dir, "status.json"), { state: "starting" });
	if (st.state !== "exited" && st.daemonPid && !alive(st.daemonPid)) st.state = "exited";
	return st;
}

function readEvents(dir) {
	const file = path.join(dir, "events.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

const cursorOf = (dir) => {
	const f = path.join(dir, "cursor");
	return Number(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : 0);
};

// ---------- 施工单范围 ----------

// 从「## 范围」里的「改：」「不碰：」两行取路径；没写就不做越界检查。
function parseScope(brief) {
	const pick = (label) => {
		const m = brief.match(new RegExp(`^\\s*[-*]?\\s*${label}\\s*[:：](.*)$`, "m"));
		if (!m) return [];
		return m[1]
			.split(/[\s,，、;；]+/)
			.map((s) => s.replace(/[`'"]/g, "").replace(/^\.\//, "").replaceAll("\\", "/").trim())
			.filter((s) => s && !/^[（(]/.test(s));
	};
	return { change: pick("改"), keepOut: pick("不碰") };
}

function matches(rel, entry) {
	if (entry.includes("*")) {
		const re = entry
			.replace(/[.+^${}()|[\]]/g, "\\$&")
			.replace(/\*\*/g, "\0")
			.replace(/\*/g, "[^/]*")
			.replaceAll("\0", ".*");
		return new RegExp(`^${re}$`).test(rel);
	}
	const e = entry.replace(/\/$/, "");
	return rel === e || rel.startsWith(`${e}/`);
}

function scopeProblem(rel, scope) {
	if (path.isAbsolute(rel)) return null; // cwd 之外（临时文件等）不管
	const listed = scope.change.some((e) => matches(rel, e));
	if (!listed && scope.keepOut.some((e) => matches(rel, e))) return "在「不碰」清单里";
	if (scope.change.length && !listed) return "不在「改」清单里";
	return null;
}

// 运行中的范围存在 scope.json，监工授权后用 piw scope 更新；旧运行目录没有它时读施工单
function scopeOf(dir) {
	return readJson(path.join(dir, "scope.json"), null) ?? parseScope(fs.readFileSync(path.join(dir, "brief.md"), "utf8"));
}

// ---------- 并行重叠提示 ----------

// 同一检出（同一 git 根目录）里的 worker 共用文件；派单和扩范围时提示与在跑 worker 的重叠，由监工决定怎么分工。
// worktree 是另一个检出，不比较。
const norm = (p) => (WIN ? p.toLowerCase() : p);
const checkouts = new Map();
function checkoutOf(cwd) {
	if (!checkouts.has(cwd)) {
		let top;
		try {
			top = norm(path.resolve(git(cwd, "rev-parse", "--show-toplevel")));
		} catch {
			top = norm(path.resolve(cwd));
		}
		checkouts.set(cwd, top);
	}
	return checkouts.get(cwd);
}

// 相对 cwd 的路径或模式 → 相对检出根目录；cwd 之外的绝对路径不参与比较
function toCheckout(meta, p) {
	if (path.isAbsolute(p)) return null;
	const sub = path.relative(meta.checkout, norm(path.resolve(meta.cwd))).replaceAll("\\", "/");
	return norm(sub ? `${sub}/${p}` : p);
}

// 在跑的 worker 认领的路径：施工单「改」清单 + 已经改过的文件
function claimsOf(dir) {
	const meta = readJson(path.join(dir, "meta.json"), null);
	if (!meta || status(dir).state === "exited") return null;
	meta.checkout ??= checkoutOf(meta.cwd);
	const up = (p) => toCheckout(meta, p);
	const scope = scopeOf(dir);
	return {
		name: meta.name,
		checkout: meta.checkout,
		change: scope.change.map(up).filter(Boolean),
		files: (status(dir).files ?? []).map(up).filter(Boolean),
	};
}

function otherClaims(self, checkout) {
	if (!fs.existsSync(RUNS)) return [];
	return fs
		.readdirSync(RUNS)
		.filter((n) => n !== self)
		.map((n) => claimsOf(runDir(n)))
		.filter((c) => c && c.checkout === checkout);
}

// 两个路径模式是否可能指向同一文件（两边都带通配时按字面前缀保守判断）
function overlaps(a, b) {
	const lit = (p) => (p.includes("*") ? p.slice(0, p.indexOf("*")) : p);
	if (!a.includes("*")) return matches(a, b) || (!b.includes("*") && matches(b, a));
	if (!b.includes("*")) return matches(b, a);
	return lit(a).startsWith(lit(b)) || lit(b).startsWith(lit(a));
}

function overlapNotes(name, meta, change) {
	const others = otherClaims(name, meta.checkout);
	if (!others.length) return [];
	const names = others.map((o) => o.name).join("、");
	const mine = change.map((p) => toCheckout(meta, p)).filter(Boolean);
	if (!mine.length) return [`同一检出里还有 ${names} 在跑；本单没写「改」清单，无法比对重叠`];
	const notes = [];
	for (const o of others)
		for (const e of mine) {
			const hit = new Set([...o.change.filter((c) => overlaps(e, c)), ...o.files.filter((f) => matches(f, e))]);
			if (hit.size) notes.push(`⚠ ${e} 与 ${o.name} 重叠：${[...hit].join(", ")}`);
		}
	return notes.length ? [...notes, "同一文件同时只该有一个写入者：调整分工、加 --worktree，或者等对方收工"] : [`与 ${names} 同一检出，「改」清单无重叠`];
}

// ---------- pi 定位与启动参数 ----------

function piCli() {
	if (process.env.PIW_PI_CLI) return process.env.PIW_PI_CLI;
	const root = run(WIN ? "npm.cmd" : "npm", ["root", "-g"], { shell: WIN }).trim();
	const pkgDir = path.join(root, "@earendil-works", "pi-coding-agent");
	const pkg = readJson(path.join(pkgDir, "package.json"), null);
	if (!pkg) die(`找不到 pi 安装（${pkgDir}）；可用 PIW_PI_CLI 指向 cli.js`);
	return path.join(pkgDir, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi);
}

// -ne 关掉了用户的全部扩展；安全底线扩展（危险命令、敏感文件一律拦截，无人值守时 ask 即拒绝）装了就单独加回来。
const SAFETY_PACKAGES = ["@yen/pi-auto-mode"];
function safetyExtensions() {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return SAFETY_PACKAGES.flatMap((name) => {
		const dir = path.join(agentDir, "npm", "node_modules", ...name.split("/"));
		const pkg = readJson(path.join(dir, "package.json"), null);
		return (pkg?.pi?.extensions ?? []).map((e) => path.join(dir, e));
	});
}

// -nc 关掉了 pi 自带的上下文文件发现（含 ~/.pi/agent 的全局说明），这里只补回项目链上的说明。
function projectContextFiles(cwd) {
	const found = [];
	let dir = path.resolve(cwd);
	while (true) {
		const hit = ["AGENTS.md", "CLAUDE.md"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
		if (hit) found.unshift(hit);
		if (fs.existsSync(path.join(dir, ".git"))) break;
		const up = path.dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return found;
}

function piArgs(meta, sessionFile) {
	const shell = WIN ? "powershell" : "bash";
	const args = [
		"--mode", "rpc",
		"-nc", "-ne", "-ns", "-np", "-na",
		"--session-dir", path.join(meta.dir, "session"),
		"--name", meta.name,
		"--model", meta.model,
		"--thinking", meta.thinking,
		"--tools", `read,${shell},edit,write,grep,find,ls,${Object.keys(REPORT_TOOLS).join(",")}`,
		"-e", path.join(HERE, "worker-ext.ts"),
		...(meta.extensions ?? []).flatMap((e) => ["-e", e]),
		"--append-system-prompt", path.join(SKILL, "references", "worker-rules.md"),
	];
	for (const f of meta.contextFiles) args.push("--append-system-prompt", f);
	if (meta.fast) args.push("--fast");
	if (sessionFile) args.push("--session", sessionFile);
	return args;
}

// ---------- 守护进程 ----------

async function daemon(name) {
	const dir = runDir(name);
	const meta = readJson(path.join(dir, "meta.json"));
	const brief = fs.readFileSync(path.join(dir, "brief.md"), "utf8");
	const eventsFile = path.join(dir, "events.jsonl");
	const inbox = path.join(dir, "inbox");
	const resumeFile = path.join(dir, "resume.md");
	const prev = readJson(path.join(dir, "status.json"), {});
	const resuming = fs.existsSync(resumeFile);
	const st = {
		state: "starting",
		daemonPid: process.pid,
		piPid: null,
		seq: resuming ? prev.seq ?? 0 : 0,
		turns: resuming ? prev.turns ?? 0 : 0,
		toolCalls: resuming ? prev.toolCalls ?? 0 : 0,
		files: resuming ? prev.files ?? [] : [],
		flagged: resuming ? prev.flagged ?? [] : [],
		cost: resuming ? prev.cost ?? 0 : 0,
		contextTokens: null,
		contextWindow: null,
		sessionFile: prev.sessionFile ?? null,
		outcome: resuming ? prev.outcome ?? null : null,
		updated: new Date().toISOString(),
	};
	const save = () => {
		st.updated = new Date().toISOString();
		writeJson(path.join(dir, "status.json"), st);
	};
	const emit = (ev) => {
		st.seq++;
		fs.appendFileSync(eventsFile, `${JSON.stringify({ seq: st.seq, t: new Date().toISOString(), ...ev })}\n`);
		save();
	};

	const child = spawn(process.execPath, [piCli(), ...piArgs(meta, resuming ? st.sessionFile : null)], {
		cwd: meta.cwd,
		// Windows 下 Python 写管道默认用 GBK，pi 按 UTF-8 读成乱码；统一让 Python 输出 UTF-8
		env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PIW_RUN_DIR: dir },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	st.piPid = child.pid;
	child.stderr.pipe(fs.createWriteStream(path.join(dir, "stderr.log"), { flags: "a" }));

	let nextId = 0;
	const pending = new Map();
	const send = (cmd) =>
		new Promise((resolve) => {
			const id = `piw-${++nextId}`;
			pending.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
		});
	// 运行状态由 agent_start / agent_settled 更新；接收确认可能晚于这些事件。
	const prompt = (message) => send({ type: "prompt", message });

	const rel = (p) => {
		const abs = path.resolve(meta.cwd, String(p ?? ""));
		const r = path.relative(meta.cwd, abs);
		return r.startsWith("..") || path.isAbsolute(r) ? abs : r.replaceAll("\\", "/");
	};
	const toolSummary = (tool, a = {}) => {
		switch (tool) {
			case "read":
				return rel(a.path) + (a.offset ? `:${a.offset}` : "");
			case "edit":
				return `${rel(a.path)}（${a.edits?.length ?? 1} 处）`;
			case "write":
				return `${rel(a.path)}（${String(a.content ?? "").split("\n").length} 行）`;
			case "bash":
			case "powershell":
				return clip(a.command, 300);
			case "grep":
				return `${clip(a.pattern, 80)} @ ${rel(a.path ?? ".")}`;
			case "find":
				return clip(a.pattern, 120);
			case "ls":
				return rel(a.path ?? ".");
			default:
				return clip(JSON.stringify(a), 200);
		}
	};
	const resultText = (r) =>
		(r?.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");

	// 重试：服务端或网络的瞬时错误，在原会话里接着干。
	let retries = 0;
	let lastError = null;
	let retryTimer = null;
	let controlEpoch = 0;
	let autoPaused = false;
	const cancelAutomatic = () => {
		controlEpoch++;
		autoPaused = true;
		clearTimeout(retryTimer);
		retryTimer = null;
		retries = 0;
		lastError = null;
	};
	const settled = () => {
		st.state = "idle";
		emit({ kind: "settled", outcome: st.outcome });
	};
	const retry = (error, attempt, action) => {
		if (autoPaused || stopping || !TRANSIENT.test(error) || attempt >= RETRY_DELAYS.length) return false;
		const epoch = controlEpoch;
		const delay = RETRY_DELAYS[attempt];
		st.state = "retrying";
		emit({ kind: "note", text: `出错，${delay} 秒后重试 ${attempt + 1}/${RETRY_DELAYS.length}：${clip(error, 200)}` });
		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (epoch === controlEpoch && !autoPaused) action();
		}, delay * 1000);
		return true;
	};
	const continueWork = async (text) => {
		const epoch = controlEpoch;
		const r = await prompt(text);
		if (!r.success && epoch === controlEpoch) settled();
	};

	// 压缩与普通请求共用退避；监工的新指令使旧压缩的续跑失效。
	let compacting = false;
	const compact = async (attempt = 0) => {
		const epoch = controlEpoch;
		compacting = true;
		st.state = "compacting";
		emit({ kind: "note", text: `上下文 ${Math.round((100 * st.contextTokens) / st.contextWindow)}%，压缩后继续` });
		const r = await send({ type: "compact", customInstructions: COMPACT_INSTRUCTIONS });
		compacting = false;
		if (epoch !== controlEpoch || autoPaused) return;
		if (!r.success) {
			if (retry(r.error, attempt, () => compact(attempt + 1))) return;
			emit({ kind: "error", text: `压缩失败：${r.error}` });
			settled();
			return;
		}
		st.contextTokens = null;
		retries = 0;
		emit({ kind: "note", text: "压缩完成，继续施工" });
		await continueWork(`（上下文已压缩。以下是施工单原文；对照压缩摘要，从未完成的部分继续。）\n\n${brief}`);
	};
	// pi 交了完工汇报或请示，这一轮就此结束；此时压缩会附上施工单把它重新叫起来，留到下一轮再压
	let stopping = false;

	const onRecord = (rec) => {
		if (rec.type === "response") {
			const resolve = pending.get(rec.id);
			if (resolve) {
				pending.delete(rec.id);
				resolve(rec);
			}
			if (!rec.success) emit({ kind: "error", text: `${rec.command}: ${rec.error}` });
			return;
		}
		switch (rec.type) {
			case "agent_start":
				stopping = false;
				st.outcome = null;
				st.state = "running";
				save();
				break;
			case "turn_start":
				st.turns++;
				break;
			case "turn_end":
				if (!autoPaused && !retryTimer && !compacting && !stopping && st.contextWindow && st.contextTokens / st.contextWindow >= COMPACT_AT) compact();
				break;
			case "tool_execution_start":
				st.toolCalls++;
				st.activeTool = rec.toolName;
				emit({ kind: "tool", tool: rec.toolName, text: toolSummary(rec.toolName, rec.args) });
				if (CHANGE_TOOLS.has(rec.toolName)) {
					const f = rel(rec.args?.path);
					const problem = scopeProblem(f, scopeOf(dir));
					// 「不碰」的写入由 worker-ext 拦下，不算本 worker 改过的文件
					const blocked = Boolean(problem?.includes("不碰"));
					if (!blocked && !st.files.includes(f)) st.files.push(f);
					if (problem && !st.flagged.includes(f)) {
						st.flagged.push(f);
						emit({ kind: "scope", hard: blocked, text: `${f}（${problem}${blocked ? "，写入已拦截" : ""}）` });
					}
				}
				break;
			case "tool_execution_end":
				st.activeTool = null;
				save();
				if (REPORT_TOOLS[rec.toolName] && !rec.isError) {
					if (rec.toolName !== "stage_report") {
						stopping = true;
						st.outcome = REPORT_TOOLS[rec.toolName];
						clearTimeout(retryTimer);
						retryTimer = null;
					}
					emit({ kind: REPORT_TOOLS[rec.toolName], text: rec.result?.details?.markdown ?? resultText(rec.result) });
					break;
				}
				if (rec.isError) emit({ kind: "tool_error", tool: rec.toolName, text: tail(resultText(rec.result), 600) });
				else if (SHELL_TOOLS.has(rec.toolName)) emit({ kind: "output", tool: rec.toolName, text: tail(resultText(rec.result), 400) });
				break;
			case "message_end": {
				const m = rec.message;
				if (m?.role !== "assistant") break;
				const u = m.usage;
				if (u) {
					st.cost += u.cost?.total ?? 0;
					st.contextTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
				}
				const text = (m.content ?? [])
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();
				if (text) {
					emit({ kind: "say", text });
				}
				if (m.stopReason === "error") lastError = m.errorMessage ?? "未知错误";
				else if (m.stopReason === "aborted") {
					if (!compacting) emit({ kind: "note", text: "当前施工已中止" });
				} else {
					lastError = null;
					retries = 0;
				}
				break;
			}
			case "compaction_end":
				if (rec.errorMessage) emit({ kind: "error", text: `压缩出错：${rec.errorMessage}` });
				break;
			case "extension_ui_request":
				if (["select", "confirm", "input", "editor"].includes(rec.method)) {
					child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: rec.id, cancelled: true })}\n`);
					emit({ kind: "note", text: `已自动取消对话框：${clip(rec.title ?? rec.message, 160)}` });
				}
				break;
			case "agent_settled":
				if (compacting || retryTimer) break;
				if (lastError && retry(lastError, retries, () => continueWork("上一步因服务或网络错误中断。检查已完成到哪里，然后继续施工。"))) {
					retries++;
					lastError = null;
					break;
				}
				if (lastError) emit({ kind: "error", text: lastError });
				lastError = null;
				settled();
				break;
		}
	};

	let buf = Buffer.alloc(0);
	child.stdout.on("data", (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		let nl;
		while ((nl = buf.indexOf(0x0a)) >= 0) {
			const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
			buf = buf.subarray(nl + 1);
			if (!line.trim()) continue;
			try {
				onRecord(JSON.parse(line));
			} catch (e) {
				emit({ kind: "error", text: `无法解析 pi 输出：${clip(line, 200)}` });
			}
		}
	});

	let poll;
	child.on("exit", (code, signal) => {
		clearInterval(poll);
		cancelAutomatic();
		st.state = "exited";
		emit({ kind: "exit", text: `pi 退出（code=${code}${signal ? `, ${signal}` : ""}）` });
		process.exit(0);
	});

	// 监工的消息：运行中走 steer，空闲时开新一轮 prompt。
	const handle = async (msg) => {
		cancelAutomatic();
		if (msg.type === "stop") {
			emit({ kind: "boss", text: "停止进程" });
			child.stdin.end();
			return { success: true, action: "stop" };
		}
		if (msg.type === "abort") {
			const r = await send({ type: "abort" });
			emit({ kind: "boss", text: `中止${r.success ? "" : `失败：${r.error}`}` });
			if (r.success) settled();
			return r;
		}
		const running = st.state === "running";
		autoPaused = false;
		const r = running ? await send({ type: "steer", message: msg.text }) : await prompt(msg.text);
		if (r.success) emit({ kind: "boss", text: `${running ? "插话" : "派发"}：${clip(msg.text, 300)}` });
		else if (!running) settled();
		return { ...r, action: running ? "steer" : "prompt" };
	};
	const acks = path.join(dir, "acks");
	fs.mkdirSync(acks, { recursive: true });
	// 进程中断时已开始投递的指令结果未知，保留原文供核对，避免盲目重放。
	for (const f of fs.readdirSync(inbox).filter((f) => f.endsWith(".processing"))) {
		const id = f.slice(0, -".processing".length);
		const ack = path.join(acks, id);
		if (!fs.existsSync(ack)) {
			const error = `消息 ${id} 在中断前未确认；查看 inbox/${f} 和会话记录，核对后再 send`;
			writeJson(ack, { success: false, error });
			emit({ kind: "error", text: error });
		}
	}
	let busy = false;
	const pollInbox = async () => {
		if (busy) return;
		busy = true;
		try {
			for (const f of fs.readdirSync(inbox).filter((f) => f.endsWith(".json")).sort()) {
				const file = path.join(inbox, f);
				const processing = `${file}.processing`;
				fs.renameSync(file, processing);
				let result;
				try {
					result = await handle(JSON.parse(fs.readFileSync(processing, "utf8")));
				} catch (error) {
					result = { success: false, error: error.message };
					emit({ kind: "error", text: `消息 ${f} 投递失败：${error.message}` });
				}
				writeJson(path.join(acks, f), result);
				fs.rmSync(processing);
				if (result.action === "stop") break;
			}
		} finally {
			busy = false;
		}
	};

	const r = await send({ type: "get_state" });
	if (r.success) {
		st.sessionFile = r.data.sessionFile ?? st.sessionFile;
		st.contextWindow = r.data.model?.contextWindow ?? null;
	} else emit({ kind: "error", text: `pi 未就绪：${r.error}` });
	st.state = "idle";
	save();
	if (resuming) {
		const text = fs.readFileSync(resumeFile, "utf8");
		fs.rmSync(resumeFile, { force: true });
		await handle({ type: "say", text });
	} else await handle({ type: "say", text: brief });
	poll = setInterval(pollInbox, 400);
}

// ---------- 监工命令 ----------

async function post(dir, msg) {
	if (status(dir).state === "exited") die("worker 已退出；用 resume 接着干");
	const file = `${Date.now()}-${randomUUID()}.json`;
	writeJson(path.join(dir, "inbox", file), msg);
	for (let i = 0; i < 100; i++) {
		await sleep(200);
		const st = status(dir);
		const ack = readJson(path.join(dir, "acks", file), null);
		if (ack) {
			if (!ack.success) die(`消息 ${file} 未成功投递：${ack.error}`);
			return ack;
		}
		if (st.state === "exited") die(`worker 已退出，消息 ${file} 未确认；核对会话后再恢复`);
	}
	die(`消息 ${file} 20 秒内未确认，可能仍在处理；先查 acks/${file} 与会话记录，勿直接重发`);
}

function headline(dir) {
	const st = status(dir);
	const meta = readJson(path.join(dir, "meta.json"));
	const mins = Math.round((Date.now() - Date.parse(meta.started)) / 60000);
	const ctx = st.contextTokens && st.contextWindow ? `${Math.round((100 * st.contextTokens) / st.contextWindow)}%` : "?";
	return [
		`[${meta.name}] ${st.state} | ${outcomeText(st)} | 已运行 ${mins} 分钟 | 改过 ${st.files?.length ?? 0} 个文件 | 上下文 ${ctx} | 费用 $${Number(st.cost ?? 0).toFixed(3)}`,
		`cwd: ${meta.cwd}${meta.worktree ? `（worktree，分支 ${meta.worktree.branch}）` : ""}`,
	];
}

function outcomeText(st) {
	return st.outcome === "report" ? "本轮已提交完工报告（待监工验收）"
		: st.outcome === "ask" ? "本轮已提交请示" : "本轮未提交完工报告";
}

// 阶段性成果：只给汇报、提问、越界和错误，不给过程。
function results(dir, reason, upto = Infinity) {
	const from = cursorOf(dir);
	const events = readEvents(dir).filter((e) => e.seq > from && e.seq <= upto);
	const changed = [...new Set(events.filter((e) => e.kind === "tool" && CHANGE_TOOLS.has(e.tool)).map((e) => e.text.replace(/（.*$/, "")))];
	const out = [`【${reason}】`, ...headline(dir)];
	if (changed.length) out.push(`本段改动：${changed.join(", ")}`);
	for (const e of events.filter((e) => e.kind === "scope")) out.push(`⚠ ${e.hard === false ? "越出「改」清单" : "越界"}：${e.text}`);
	for (const e of events.filter((e) => e.kind === "error" || e.kind === "note")) out.push(`${e.kind === "error" ? "错误" : "注"}：${e.text}`);
	const reports = events.filter((e) => ["milestone", "report", "ask"].includes(e.kind));
	const lastSay = [...events].reverse().find((e) => ["say", "milestone", "report", "ask"].includes(e.kind));
	const stopped = events.some((e) => e.kind === "settled" || e.kind === "exit");
	for (const e of reports) out.push("", e.text);
	if (stopped && lastSay && lastSay.kind === "say") out.push("", "—— 停下前的最后一段话 ——", lastSay.text);
	if (events.length) fs.writeFileSync(path.join(dir, "cursor"), String(events.at(-1).seq));
	return out.join("\n");
}

// 过程明细：排查时看。
function timeline(dir, since) {
	const all = readEvents(dir);
	const events = since === undefined ? all.slice(-80) : all.filter((e) => e.seq > since);
	const verb = { read: "读", edit: "改", write: "写", bash: "跑", powershell: "跑", grep: "搜", find: "找", ls: "列" };
	const label = { tool_error: "  ↳ 出错", output: "  ↳", error: "错误", note: "注", boss: "监工", exit: "退出", scope: "⚠ 越界" };
	const lines = events.map((e) => {
		if (e.kind === "tool") return `#${e.seq} ${verb[e.tool] ?? e.tool} ${e.text}`;
		if (["say", "milestone", "report", "ask"].includes(e.kind)) return `#${e.seq} ${e.kind === "say" ? "说" : "报"}：${clip(e.text, 240)}`;
		if (e.kind === "settled") return `#${e.seq} —— 停下 ——`;
		return `#${e.seq} ${label[e.kind] ?? e.kind}：${e.text}`;
	});
	return [...headline(dir), ...lines].join("\n");
}

function makeWorktree(cwd, name) {
	const root = git(cwd, "rev-parse", "--show-toplevel");
	const sub = path.relative(root, cwd);
	const wt = path.join(path.dirname(root), `${path.basename(root)}-pi-${name}`);
	const branch = `pi/${name}`;
	if (fs.existsSync(wt)) die(`worktree 目录已存在：${wt}`);
	const base = git(root, "rev-parse", "HEAD");
	git(root, "worktree", "add", "-b", branch, wt, base);
	return { cwd: path.join(wt, sub), worktree: { path: wt, branch, base, repo: root } };
}

function spawnDaemon(dir, name, cwd) {
	spawn(process.execPath, [fileURLToPath(import.meta.url), "daemon", name], {
		cwd,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	}).unref();
}

async function waitStarted(dir) {
	for (let i = 0; i < 150; i++) {
		await sleep(200);
		const st = status(dir);
		if (st.state !== "starting") return;
	}
}

async function cmdStart(name, opt) {
	if (!name || !/^[\w.-]+$/.test(name)) die("worker 名只能用字母、数字、._-");
	if (!opt.brief) die("缺少 --brief <施工单文件>");
	const dir = runDir(name);
	if (fs.existsSync(dir)) {
		if (status(dir).state !== "exited") die(`${name} 仍在运行；先 stop，或换个名字`);
		fs.rmSync(dir, { recursive: true, force: true });
	}
	let cwd = path.resolve(opt.cwd ?? process.cwd());
	let worktree = null;
	const checkout = checkoutOf(cwd);
	const mine = parseScope(fs.readFileSync(path.resolve(opt.brief), "utf8"));
	const overlap = opt.worktree ? [] : overlapNotes(name, { cwd, checkout }, mine.change);
	if (opt.worktree) ({ cwd, worktree } = makeWorktree(cwd, name));
	fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
	const meta = {
		name,
		dir,
		cwd,
		checkout: worktree ? checkoutOf(cwd) : checkout,
		worktree,
		model: opt.model ?? DEFAULTS.model,
		thinking: opt.thinking ?? DEFAULTS.thinking,
		fast: opt["no-fast"] ? false : DEFAULTS.fast,
		contextFiles: projectContextFiles(cwd),
		extensions: safetyExtensions(),
		started: new Date().toISOString(),
	};
	fs.copyFileSync(path.resolve(opt.brief), path.join(dir, "brief.md"));
	writeJson(path.join(dir, "meta.json"), meta);
	if (opt.adopt) {
		// 接管别处跑过的 pi 会话：沿用它的上下文，以施工单为准继续
		const sessionFile = path.resolve(opt.adopt);
		if (!fs.existsSync(sessionFile)) die(`找不到会话文件：${sessionFile}`);
		writeJson(path.join(dir, "status.json"), { state: "starting", sessionFile });
		const brief = fs.readFileSync(path.join(dir, "brief.md"), "utf8");
		fs.writeFileSync(path.join(dir, "resume.md"), `（监工接管了这个会话：之前的进程已停止，此后经由监工沟通。以下施工单为准；先核对之前做到哪一步，再继续。）

${brief}`);
	}
	const scope = mine;
	writeJson(path.join(dir, "scope.json"), scope);
	// 已读位置从开工前算起：pi 在 start 返回前就交的汇报或请示，第一次 wait 也能收到
	fs.writeFileSync(path.join(dir, "cursor"), "0");
	spawnDaemon(dir, name, cwd);
	await waitStarted(dir);
	console.log(`已派单 ${name}：${meta.model}:${meta.thinking}${meta.fast ? " fast" : ""}`);
	console.log(`项目说明：${meta.contextFiles.join(", ") || "无"}`);
	console.log(`安全扩展：${meta.extensions.join(", ") || "未安装"}`);
	if (opt.adopt) console.log(`接管会话：${path.resolve(opt.adopt)}`);
	console.log(`越界检查：改 [${scope.change.join(", ") || "未写，不检查"}]；不碰 [${scope.keepOut.join(", ") || "无"}]`);
	for (const n of overlap) console.log(`并行：${n}`);
	if (worktree) console.log(`worktree：${worktree.path}（分支 ${worktree.branch}，基于 ${worktree.base.slice(0, 8)}）`);
	console.log(headline(dir).join("\n"));
}

async function cmdResume(name, opt, text) {
	const dir = requireRun(name);
	const st = status(dir);
	if (st.state !== "exited") die(`${name} 还在运行，不需要 resume`);
	if (!st.sessionFile || !fs.existsSync(st.sessionFile)) die("找不到原会话文件，只能重新 start");
	if (opt.file) text = fs.readFileSync(path.resolve(opt.file), "utf8");
	fs.writeFileSync(path.join(dir, "resume.md"), text?.trim() || "进程中断后恢复。先确认施工单已完成到哪一步，然后继续。");
	// 旧进程的退出事件已经看过；状态清回 starting，免得读到旧 pid 判成已退出
	fs.writeFileSync(path.join(dir, "cursor"), String(st.seq ?? 0));
	writeJson(path.join(dir, "status.json"), { ...st, state: "starting", daemonPid: null });
	const meta = readJson(path.join(dir, "meta.json"));
	spawnDaemon(dir, name, meta.cwd);
	await waitStarted(dir);
	console.log(`已在原会话上恢复 ${name}`);
	console.log(headline(dir).join("\n"));
}

async function cmdWait(names, opt) {
	if (!names.length) die("缺少 worker 名");
	const started = Date.now();
	const deadline = opt.timeout ? started + Number(opt.timeout) * 1000 : Infinity;
	const stallMs = Number(opt.stall ?? 30) * 60000;
	const wakes = (e) => e.kind === "settled" || e.kind === "exit"
		|| (e.kind === "scope" && (e.hard !== false || opt.milestones))
		|| (e.kind === "milestone" && opt.milestones);
	const watch = names.map((name) => {
		const dir = requireRun(name);
		return { dir, from: cursorOf(dir) };
	});
	const check = ({ dir, from }) => {
		const events = readEvents(dir);
		const hit = events.filter((e) => e.seq > from && wakes(e));
		const st = status(dir);
		if (hit.length || st.state === "exited") {
			const kinds = new Set(hit.map((e) => e.kind));
			const upto = hit.length ? hit.at(-1).seq : Infinity;
			const signal = hit.findLast((e) => e.kind === "settled")?.outcome;
			return {
				// 截到最后一条触发事件，之后的动态留给下一次 wait
				upto,
				reason: kinds.has("exit") || st.state === "exited" ? "worker 已退出"
					: kinds.has("settled") && signal === "report" ? "完成汇报"
					: kinds.has("settled") && signal === "ask" ? "请示监工"
					: kinds.has("settled") ? "停下，等待指示"
					: kinds.has("scope") ? "越界提醒"
					: "里程碑",
			};
		}
		// 没有定时空醒；只有长时间没有任何动静才叫醒（有命令在跑时放宽三倍，给整库测试留时间）
		const last = Math.max(started, Date.parse(events.at(-1)?.t ?? 0), Date.parse(st.updated ?? 0));
		const limit = st.activeTool ? stallMs * 3 : stallMs;
		if (["running", "compacting", "retrying"].includes(st.state) && Date.now() - last > limit)
			return { reason: `疑似卡住：${Math.round((Date.now() - last) / 60000)} 分钟没有动静${st.activeTool ? `（${st.activeTool} 仍在执行）` : ""}` };
		return null;
	};
	while (Date.now() < deadline) {
		const done = watch.map((w) => [w, check(w)]).filter(([, r]) => r);
		if (done.length) return console.log(done.map(([w, r]) => results(w.dir, r.reason, r.upto)).join("\n\n"));
		await sleep(2000);
	}
	console.log(watch.map((w) => results(w.dir, "超时，仍在施工")).join("\n\n"));
}

function cmdScope(name, [action, ...paths]) {
	const dir = requireRun(name);
	const scope = scopeOf(dir);
	if (action) {
		const key = { add: "change", "keep-out": "keepOut" }[action];
		if (!key || !paths.length) die("用法：piw scope <名> [add|keep-out <路径>...]");
		const clean = paths.map((p) => p.replaceAll("\\", "/").replace(/^\.\//, ""));
		if (key === "change") {
			const meta = readJson(path.join(dir, "meta.json"));
			meta.checkout ??= checkoutOf(meta.cwd);
			for (const n of overlapNotes(name, meta, clean)) if (n.startsWith("⚠") || n.startsWith("同一文件")) console.log(`并行：${n}`);
		}
		scope[key] = [...new Set([...scope[key], ...clean])];
		writeJson(path.join(dir, "scope.json"), scope);
	}
	console.log(`改 [${scope.change.join(", ") || "未写，不检查"}]\n不碰 [${scope.keepOut.join(", ") || "无"}]`);
	if (action) console.log("范围已更新：越界检查和「不碰」写入拦截即时生效。要让 pi 知道，再 send 一句说明。");
}

async function cmdSend(name, opt, text) {
	const dir = requireRun(name);
	if (opt.file) text = fs.readFileSync(path.resolve(opt.file), "utf8");
	if (!text?.trim()) die("消息为空");
	const ack = await post(dir, { type: "say", text });
	console.log(ack.action === "steer" ? "已插话（当前工具调用结束后送达）" : "已派发新一轮");
}

async function cmdAbort(name) {
	const dir = requireRun(name);
	await post(dir, { type: "abort" });
	console.log("已中止当前施工；worker 保留上下文，可 send 新指示");
}

async function cmdStop(name, opt) {
	const dir = requireRun(name);
	const st = status(dir);
	const meta = readJson(path.join(dir, "meta.json"));
	if (st.state !== "exited") {
		if (opt.force) {
			for (const pid of [st.piPid, st.daemonPid].filter(Boolean)) {
				try {
					if (WIN) run("taskkill", ["/PID", String(pid), "/T", "/F"]);
					else process.kill(pid, "SIGKILL");
				} catch {}
			}
		} else {
			writeJson(path.join(dir, "inbox", `${Date.now()}-${randomUUID()}.json`), { type: "stop" });
			for (let i = 0; i < 50 && status(dir).state !== "exited"; i++) await sleep(200);
		}
	}
	const final = status(dir);
	console.log(final.state === "exited" ? `已停止；${outcomeText(final)}` : "已请求停止；未退出可用 stop --force");
	if (meta.worktree) console.log(`worktree 保留在 ${meta.worktree.path}（分支 ${meta.worktree.branch}）。交付后先停 writer、核对路径并检查整树链接；Windows 用 scripts/check-worktree-removal.ps1。检查通过才普通 git worktree remove，不加 --force。`);
}

function cmdList() {
	if (!fs.existsSync(RUNS)) return console.log("还没有 worker");
	for (const name of fs.readdirSync(RUNS)) {
		const dir = runDir(name);
		const meta = readJson(path.join(dir, "meta.json"), null);
		if (!meta) continue;
		const st = status(dir);
		console.log(`${name}\t${st.state}\t${outcomeText(st)}\t改过 ${st.files?.length ?? 0} 个文件\t${meta.cwd}\t${meta.started}`);
	}
}

// 用量与速率：从 pi 会话逐条读 assistant 消息。message.timestamp 是请求开始、条目 timestamp 是写入（结束），
// 二者之差即这一轮的模型时间（含首字延迟），不含等工具的时间。
function cmdStats(name, opt) {
	const dir = requireRun(name);
	const file = status(dir).sessionFile;
	if (!file || !fs.existsSync(file)) die("还没有会话记录");
	const turns = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		const m = e.message;
		// 中止或出错的请求没有用量，算进来只会拉低速率
		if (m?.role !== "assistant" || !m.usage?.totalTokens || !e.timestamp || !m.timestamp) continue;
		const secs = (Date.parse(e.timestamp) - Number(m.timestamp)) / 1000;
		turns.push({ at: e.timestamp, secs: Math.max(secs, 0), ...m.usage });
	}
	if (!turns.length) die("会话里还没有模型回复");
	const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] ?? 0), 0);
	const rate = (rows) => {
		const secs = sum(rows, "secs");
		return secs > 0 ? `${Math.round(sum(rows, "output") / secs)} tok/s` : "—";
	};
	const long = turns.filter((t) => (t.output ?? 0) >= 300);
	const prompt = sum(turns, "input") + sum(turns, "cacheRead") + sum(turns, "cacheWrite");
	const cost = turns.reduce((s, t) => s + (t.cost?.total ?? 0), 0);
	const wall = (Date.parse(turns.at(-1).at) - Date.parse(turns[0].at)) / 1000;
	const mins = (s) => `${(s / 60).toFixed(1)} 分钟`;
	const last = Number(opt.last ?? 10);
	console.log(`[${name}] ${turns.length} 轮 · 模型时间 ${mins(sum(turns, "secs"))} / 墙钟 ${mins(wall)} · 费用 $${cost.toFixed(3)}`);
	console.log(`输出 ${sum(turns, "output")}（其中推理 ${sum(turns, "reasoning")}）· 输入 ${sum(turns, "input")} · 缓存读 ${sum(turns, "cacheRead")} · 缓存写 ${sum(turns, "cacheWrite")}`);
	console.log(`缓存命中 ${prompt ? Math.round((100 * sum(turns, "cacheRead")) / prompt) : 0}% · 速率：长回复(≥300 输出) ${rate(long)}（${long.length} 轮）· 全部 ${rate(turns)}`);
	if (last > 0) {
		console.log(`最近 ${Math.min(last, turns.length)} 轮：`);
		for (const t of turns.slice(-last)) {
			const r = t.secs > 0 ? Math.round((t.output ?? 0) / t.secs) : 0;
			console.log(`  ${t.at.slice(11, 19)}  ${t.secs.toFixed(1).padStart(5)}s  输出 ${String(t.output ?? 0).padStart(5)}  ${String(r).padStart(4)} tok/s  缓存读 ${t.cacheRead ?? 0}`);
		}
	}
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = parseArgs(rest);
const USAGE = `用法：
  piw start  <名> --brief <施工单.md> [--cwd 目录] [--worktree] [--adopt 会话.jsonl] [--model p/id] [--thinking 级别] [--no-fast]
  piw wait   <名>... [--milestones] [--stall 分钟=30] [--timeout 秒]
             完成汇报 / 停下 / 越界 / 退出 / 疑似卡住 时返回，里程碑攒到返回时一起给；--milestones 逐段返回
             给多个名字时哪个先有结果就返回哪个
  piw log    <名> [--since 序号]            过程明细（默认最近 80 条）
  piw stats  <名> [--last N=10]             用量、缓存命中、费用与输出速率（tok/s）
  piw send   <名> "消息" | --file 文件      运行中插话，停下时派发新一轮
  piw scope  <名> [add|keep-out <路径>...]   查看或扩充范围（授权 pi 改清单外的文件时用）
  piw abort  <名>
  piw resume <名> ["消息" | --file 文件]    进程退出后在原会话上恢复
  piw stop   <名> [--force]
  piw list`;
switch (cmd) {
	case "daemon":
		await daemon(pos[0]);
		break;
	case "start":
		await cmdStart(pos[0], opt);
		break;
	case "wait":
		await cmdWait(pos, opt);
		break;
	case "log":
		console.log(timeline(requireRun(pos[0]), opt.since === undefined ? undefined : Number(opt.since)));
		break;
	case "stats":
		cmdStats(pos[0], opt);
		break;
	case "send":
		await cmdSend(pos[0], opt, pos.slice(1).join(" "));
		break;
	case "scope":
		cmdScope(pos[0], pos.slice(1));
		break;
	case "abort":
		await cmdAbort(pos[0]);
		break;
	case "resume":
		await cmdResume(pos[0], opt, pos.slice(1).join(" "));
		break;
	case "stop":
		await cmdStop(pos[0], opt);
		break;
	case "list":
		cmdList();
		break;
	default:
		console.log(USAGE);
}
