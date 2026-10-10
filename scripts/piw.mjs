#!/usr/bin/env node
// piw：把 pi 的 RPC 模式包成"施工 worker"。每个 worker 一个常驻后台进程，
// 监工经由运行目录里的 inbox/、events.jsonl、status.json 与它往来。
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.dirname(HERE);
const RUNS = process.env.PIW_HOME || path.join(os.homedir(), ".claude", "pi-worker");
const WIN = process.platform === "win32";

const DEFAULTS = { model: "openai-codex/gpt-6.1-sol", thinking: "high", fast: true };
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const CHANGE_TOOLS = new Set(["edit", "write"]);

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

// ---------- pi 定位与启动参数 ----------

function piCli() {
	if (process.env.PIW_PI_CLI) return process.env.PIW_PI_CLI;
	const root = execFileSync(WIN ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", shell: WIN }).trim();
	const pkgDir = path.join(root, "@earendil-works", "pi-coding-agent");
	const pkg = readJson(path.join(pkgDir, "package.json"), null);
	if (!pkg) die(`找不到 pi 安装（${pkgDir}）；可用 PIW_PI_CLI 指向 cli.js`);
	return path.join(pkgDir, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi);
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

function piArgs(meta) {
	const shell = WIN ? "powershell" : "bash";
	const args = [
		"--mode", "rpc",
		"-nc", "-ne", "-ns", "-np", "-na",
		"--session-dir", path.join(meta.dir, "session"),
		"--name", meta.name,
		"--model", meta.model,
		"--thinking", meta.thinking,
		"--tools", `read,${shell},edit,write,grep,find,ls`,
		"-e", path.join(HERE, "worker-ext.ts"),
		"--append-system-prompt", path.join(SKILL, "references", "worker-rules.md"),
	];
	for (const f of meta.contextFiles) args.push("--append-system-prompt", f);
	if (meta.fast) args.push("--fast");
	return args;
}

// ---------- 守护进程 ----------

async function daemon(name) {
	const dir = runDir(name);
	const meta = readJson(path.join(dir, "meta.json"));
	const eventsFile = path.join(dir, "events.jsonl");
	const inbox = path.join(dir, "inbox");
	const st = {
		state: "starting",
		daemonPid: process.pid,
		piPid: null,
		seq: 0,
		turns: 0,
		toolCalls: 0,
		changes: 0,
		files: [],
		lastSay: null,
		lastInbox: null,
		stats: null,
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

	const child = spawn(process.execPath, [piCli(), ...piArgs(meta)], {
		cwd: meta.cwd,
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

	const rel = (p) => {
		const abs = path.resolve(meta.cwd, String(p ?? ""));
		const r = path.relative(meta.cwd, abs);
		return r.startsWith("..") ? abs : r.replaceAll("\\", "/");
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
				st.state = "running";
				save();
				break;
			case "turn_start":
				st.turns++;
				break;
			case "tool_execution_start":
				st.toolCalls++;
				if (CHANGE_TOOLS.has(rec.toolName)) {
					st.changes++;
					const f = rel(rec.args?.path);
					if (!st.files.includes(f)) st.files.push(f);
				}
				emit({ kind: "tool", tool: rec.toolName, text: toolSummary(rec.toolName, rec.args) });
				break;
			case "tool_execution_end":
				if (rec.isError) emit({ kind: "tool_error", tool: rec.toolName, text: tail(resultText(rec.result), 600) });
				else if (SHELL_TOOLS.has(rec.toolName)) emit({ kind: "output", tool: rec.toolName, text: tail(resultText(rec.result), 400) });
				break;
			case "message_end": {
				const m = rec.message;
				if (m?.role !== "assistant") break;
				const text = (m.content ?? [])
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();
				if (text) {
					st.lastSay = text;
					emit({ kind: "say", text });
				}
				if (m.stopReason === "error" || m.stopReason === "aborted")
					emit({ kind: "error", text: `${m.stopReason}: ${m.errorMessage ?? ""}` });
				break;
			}
			case "auto_retry_start":
				emit({ kind: "note", text: `重试 ${rec.attempt}/${rec.maxAttempts}：${clip(rec.errorMessage, 200)}` });
				break;
			case "compaction_start":
				emit({ kind: "note", text: `上下文压缩（${rec.reason}）` });
				break;
			case "extension_ui_request":
				if (["select", "confirm", "input", "editor"].includes(rec.method)) {
					child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: rec.id, cancelled: true })}\n`);
					emit({ kind: "note", text: `已自动取消对话框：${clip(rec.title ?? rec.message, 160)}` });
				}
				break;
			case "agent_settled":
				send({ type: "get_session_stats" }).then((r) => {
					if (r.success) st.stats = { cost: r.data.cost, context: r.data.contextUsage?.percent ?? null };
					st.state = "idle";
					emit({ kind: "settled" });
				});
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
		st.state = "exited";
		emit({ kind: "exit", text: `pi 退出（code=${code}${signal ? `, ${signal}` : ""}）` });
		process.exit(0);
	});

	// 监工的消息：运行中走 steer，空闲时开新一轮 prompt。
	const handle = async (msg) => {
		if (msg.type === "stop") {
			emit({ kind: "note", text: "监工收工" });
			child.stdin.end();
			return;
		}
		if (msg.type === "abort") {
			const r = await send({ type: "abort" });
			st.state = "idle";
			emit({ kind: "boss", text: `中止${r.success ? "" : `失败：${r.error}`}` });
			return;
		}
		const running = st.state === "running";
		const r = await send(running ? { type: "steer", message: msg.text } : { type: "prompt", message: msg.text });
		if (r.success && !running) st.state = "running";
		emit({ kind: "boss", text: `${running ? "插话" : "派单"}：${clip(msg.text, 300)}` });
	};
	let busy = false;
	poll = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			for (const f of fs.readdirSync(inbox).filter((f) => f.endsWith(".json")).sort()) {
				const file = path.join(inbox, f);
				const msg = readJson(file, null);
				fs.rmSync(file, { force: true });
				if (msg) {
					await handle(msg);
					st.lastInbox = f;
					save();
				}
			}
		} finally {
			busy = false;
		}
	}, 400);

	const r = await send({ type: "get_state" });
	if (!r.success) emit({ kind: "error", text: `pi 未就绪：${r.error}` });
	st.state = "idle";
	save();
	await handle({ type: "say", text: fs.readFileSync(path.join(dir, "brief.md"), "utf8") });
}

// ---------- 监工命令 ----------

async function post(dir, msg) {
	const file = `${Date.now()}-${process.pid}.json`;
	fs.writeFileSync(path.join(dir, "inbox", file), JSON.stringify(msg));
	for (let i = 0; i < 100; i++) {
		await sleep(200);
		const st = status(dir);
		if (st.lastInbox && st.lastInbox >= file) return st;
		if (st.state === "exited") die("worker 已退出");
	}
	die("worker 20 秒内没有接收消息");
}

function digest(dir, { since, mark = true } = {}) {
	const cursorFile = path.join(dir, "cursor");
	const from = since ?? Number(fs.existsSync(cursorFile) ? fs.readFileSync(cursorFile, "utf8") : 0);
	const events = fs.existsSync(path.join(dir, "events.jsonl"))
		? fs
				.readFileSync(path.join(dir, "events.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
				.filter((e) => e.seq > from)
		: [];
	const st = status(dir);
	const meta = readJson(path.join(dir, "meta.json"));
	const label = { tool: "", tool_error: "  ↳ 出错", output: "  ↳", say: "说", error: "错误", note: "注", boss: "监工", settled: "停下", exit: "退出" };
	const verb = { read: "读", edit: "改", write: "写", bash: "跑", powershell: "跑", grep: "搜", find: "找", ls: "列" };
	const lines = events.map((e) => {
		if (e.kind === "tool") return `#${e.seq} ${verb[e.tool] ?? e.tool} ${e.text}`;
		if (e.kind === "say") return `#${e.seq} 说：${clip(e.text, 240)}`;
		if (e.kind === "settled") return `#${e.seq} —— 停下，等待指示 ——`;
		return `#${e.seq} ${label[e.kind] ?? e.kind}：${e.text}`;
	});
	const MAX = 80;
	const shown = lines.length > MAX ? [`（省略较早的 ${lines.length - MAX} 条，可用 log --since ${from} 看全）`, ...lines.slice(-MAX)] : lines;
	const ctx = st.stats?.context == null ? "?" : Math.round(st.stats.context);
	const stats = st.stats ? ` | 上下文 ${ctx}% | 费用 $${Number(st.stats.cost ?? 0).toFixed(3)}` : "";
	const out = [
		`[${meta.name}] ${st.state} | 回合 ${st.turns ?? 0} | 工具 ${st.toolCalls ?? 0} | 改动 ${st.changes ?? 0} 次 / ${st.files?.length ?? 0} 个文件${stats}`,
		`cwd: ${meta.cwd}`,
		st.files?.length ? `改过：${st.files.join(", ")}` : null,
		events.length ? `—— 新动态 #${events[0].seq}–#${events.at(-1).seq} ——` : "—— 无新动态 ——",
		...shown,
	];
	const lastSay = [...events].reverse().find((e) => e.kind === "say");
	if (lastSay) out.push("—— 最近一段原话 ——", lastSay.text);
	if (mark && events.length) fs.writeFileSync(cursorFile, String(events.at(-1).seq));
	return out.filter((l) => l !== null).join("\n");
}

async function cmdStart(name, opt) {
	if (!name || !/^[\w.-]+$/.test(name)) die("worker 名只能用字母、数字、._-");
	if (!opt.brief) die("缺少 --brief <施工单文件>");
	const dir = runDir(name);
	if (fs.existsSync(dir)) {
		if (status(dir).state !== "exited") die(`${name} 仍在运行；先 stop，或换个名字`);
		fs.rmSync(dir, { recursive: true, force: true });
	}
	fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
	const cwd = path.resolve(opt.cwd ?? process.cwd());
	const meta = {
		name,
		dir,
		cwd,
		model: opt.model ?? DEFAULTS.model,
		thinking: opt.thinking ?? DEFAULTS.thinking,
		fast: opt["no-fast"] ? false : DEFAULTS.fast,
		contextFiles: projectContextFiles(cwd),
		started: new Date().toISOString(),
	};
	fs.copyFileSync(path.resolve(opt.brief), path.join(dir, "brief.md"));
	writeJson(path.join(dir, "meta.json"), meta);
	const d = spawn(process.execPath, [fileURLToPath(import.meta.url), "daemon", name], {
		cwd,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	d.unref();
	for (let i = 0; i < 150; i++) {
		await sleep(200);
		const st = status(dir);
		if (st.state === "running" || st.state === "exited" || (st.seq ?? 0) > 0) break;
	}
	console.log(`已派单 ${name}：${meta.model}:${meta.thinking}${meta.fast ? " fast" : ""}`);
	console.log(`项目说明：${meta.contextFiles.join(", ") || "无"}`);
	console.log(digest(dir));
}

async function cmdWait(name, opt) {
	const dir = requireRun(name);
	const every = Number(opt.every ?? 8);
	const deadline = Date.now() + Number(opt.timeout ?? 1500) * 1000;
	const cursor = Number(fs.existsSync(path.join(dir, "cursor")) ? fs.readFileSync(path.join(dir, "cursor"), "utf8") : 0);
	const startChanges = (() => {
		// 检查点从上次查看后的改动数起算
		const evs = fs.existsSync(path.join(dir, "events.jsonl")) ? fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean) : [];
		return evs.map((l) => JSON.parse(l)).filter((e) => e.seq <= cursor && e.kind === "tool" && CHANGE_TOOLS.has(e.tool)).length;
	})();
	let reason = "超时，仍在施工";
	while (Date.now() < deadline) {
		const st = status(dir);
		if (st.state === "exited") {
			reason = "worker 已退出";
			break;
		}
		if (st.state === "idle" && (st.seq ?? 0) > cursor) {
			reason = "worker 停下，等待指示";
			break;
		}
		if (every > 0 && (st.changes ?? 0) - startChanges >= every) {
			reason = `检查点：又改了 ${(st.changes ?? 0) - startChanges} 次文件`;
			break;
		}
		await sleep(1000);
	}
	console.log(`【${reason}】`);
	console.log(digest(dir));
}

async function cmdSend(name, opt, text) {
	const dir = requireRun(name);
	if (opt.file) text = fs.readFileSync(path.resolve(opt.file), "utf8");
	if (!text?.trim()) die("消息为空");
	const before = status(dir).state;
	await post(dir, { type: "say", text });
	console.log(before === "running" ? "已插话（当前工具调用结束后送达）" : "已派发新一轮");
}

async function cmdAbort(name) {
	const dir = requireRun(name);
	await post(dir, { type: "abort" });
	console.log("已中止当前施工；worker 保留上下文，可 send 新指示");
}

async function cmdStop(name, opt) {
	const dir = requireRun(name);
	const st = status(dir);
	if (st.state === "exited") return console.log("已经退出");
	if (opt.force) {
		for (const pid of [st.piPid, st.daemonPid].filter(Boolean)) {
			try {
				if (WIN) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
				else process.kill(pid, "SIGKILL");
			} catch {}
		}
		return console.log("已强制结束");
	}
	fs.writeFileSync(path.join(dir, "inbox", `${Date.now()}-stop.json`), JSON.stringify({ type: "stop" }));
	for (let i = 0; i < 50 && status(dir).state !== "exited"; i++) await sleep(200);
	console.log(status(dir).state === "exited" ? "已收工" : "已请求收工；未退出可用 stop --force");
}

function cmdList() {
	if (!fs.existsSync(RUNS)) return console.log("还没有 worker");
	for (const name of fs.readdirSync(RUNS)) {
		const dir = runDir(name);
		const meta = readJson(path.join(dir, "meta.json"), null);
		if (!meta) continue;
		const st = status(dir);
		console.log(`${name}\t${st.state}\t改动 ${st.changes ?? 0}\t${meta.cwd}\t${meta.started}`);
	}
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = parseArgs(rest);
const USAGE = `用法：
  piw start <名> --brief <施工单.md> [--cwd 目录] [--model p/id] [--thinking 级别] [--no-fast]
  piw wait  <名> [--every N改动=8, 0关闭] [--timeout 秒=1500]
  piw log   <名> [--since 序号]
  piw send  <名> "消息" | --file 文件
  piw abort <名>
  piw stop  <名> [--force]
  piw list`;
switch (cmd) {
	case "daemon":
		await daemon(pos[0]);
		break;
	case "start":
		await cmdStart(pos[0], opt);
		break;
	case "wait":
		await cmdWait(pos[0], opt);
		break;
	case "log":
		console.log(digest(requireRun(pos[0]), { since: opt.since === undefined ? undefined : Number(opt.since) }));
		break;
	case "send":
		await cmdSend(pos[0], opt, pos.slice(1).join(" "));
		break;
	case "abort":
		await cmdAbort(pos[0]);
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
