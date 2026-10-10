// 施工 worker 专用的 pi 扩展（由 piw 加载）：
// - 汇报工具 stage_report / final_report / ask_supervisor：成果走结构化工具调用，piw 据此判断阶段、完工和请示；
// - 写入守卫：「不碰」清单（$PIW_RUN_DIR/scope.json）和同检出其他 worker 负责的文件（foreign.json）在 edit/write 前拦截；
// - git 写操作留给监工；--fast 走 OpenAI priority 档位。
import { readFileSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_WRITE =
	/\bgit\s+(?:-C\s+\S+\s+)?(commit|push|pull|fetch|merge|rebase|reset|revert|checkout|switch|restore|clean|stash|cherry-pick|tag|branch\s+-[dDmM]|worktree|am|apply)\b/i;

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p).replaceAll("\\", "/");

// 与 piw.mjs 的 matches 同义：目录前缀或 * / ** 通配
function matches(rel: string, entry: string) {
	entry = norm(entry);
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

function runFile<T>(name: string): T | undefined {
	const dir = process.env.PIW_RUN_DIR;
	if (!dir) return undefined;
	try {
		return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
	} catch {
		return undefined;
	}
}

type Scope = { change: string[]; keepOut: string[] };
type Foreign = { checkout: string; workers: { name: string; change: string[]; files: string[] }[] };

// 写入被拒的理由；放行时返回 undefined
function writeGuard(file: string, cwd: string) {
	const abs = path.resolve(cwd, file);
	const foreign = runFile<Foreign>("foreign.json");
	if (foreign) {
		const rel = norm(path.relative(foreign.checkout, abs));
		const owner = foreign.workers.find((w) => w.change.some((e) => matches(rel, e)) || w.files.includes(rel));
		if (owner) return `${file} 由同一工作区里在跑的 worker ${owner.name} 负责，同一文件只能有一个写入者。`;
	}
	const scope = runFile<Scope>("scope.json");
	if (scope) {
		const rel = norm(path.relative(cwd, abs));
		if (!scope.change.some((e) => matches(rel, e)) && scope.keepOut.some((e) => matches(rel, e)))
			return `${file} 在施工单的「不碰」清单里。`;
	}
	return undefined;
}

// ---------- 汇报工具 ----------

const fields = {
	changes: Type.String({ description: "改动：每个文件一行，说明改了什么" }),
	verification: Type.String({ description: "验证：跑了哪些命令，结果如何" }),
	deviations: Type.String({ description: "偏离：与施工单不同之处及原因；没有写「无」" }),
	pending: Type.String({ description: "待定：需要监工决定、但不妨碍继续的问题；没有写「无」" }),
};
const body = (p: { changes: string; verification: string; deviations: string; pending: string }) =>
	`改动：${p.changes}\n验证：${p.verification}\n偏离：${p.deviations}\n待定：${p.pending}`;
const done = (text: string, markdown: string, terminate = false) => ({
	content: [{ type: "text" as const, text }],
	details: { markdown },
	terminate,
});

const stageReport = defineTool({
	name: "stage_report",
	label: "阶段汇报",
	description: "完成施工单的一个阶段并跑过该阶段的验证后调用，向监工汇报这一阶段的成果。调用后直接开始下一阶段，不要等回复。",
	parameters: Type.Object({ stage: Type.String({ description: "阶段序号与名称，如「2：回测入口归并」" }), ...fields }),
	async execute(_id, p) {
		const md = `## 里程碑 ${p.stage}\n${body(p)}`;
		return done("阶段汇报已记录。继续下一阶段。", md);
	},
});

const finalReport = defineTool({
	name: "final_report",
	label: "完工汇报",
	description: "全部阶段完成、施工单的验收命令也跑过之后调用一次，提交最终汇报；调用后本轮结束。施工单要求的总结格式写进 summary。",
	parameters: Type.Object({
		summary: Type.Optional(Type.String({ description: "施工单要求的总结（例如限定行数的结论）" })),
		...fields,
	}),
	async execute(_id, p) {
		const md = `## 汇报\n${p.summary ? `${p.summary}\n\n` : ""}${body(p)}`;
		return done("完工汇报已提交给监工，本轮结束。", md, true);
	},
});

const askSupervisor = defineTool({
	name: "ask_supervisor",
	label: "请示监工",
	description:
		"遇到会改变方案的问题（接口、数据结构、范围、要不要做某件事）、施工单与代码现状冲突、或触发施工单的停工条件时调用；调用后本轮结束，等监工回复再继续。施工单精神之内的细节自己决定，不用请示。",
	parameters: Type.Object({
		question: Type.String({ description: "需要监工决定的问题，一句话" }),
		facts: Type.String({ description: "看到的事实：文件位置、代码行为、测试输出" }),
		options: Type.String({ description: "可选做法及各自后果" }),
		recommendation: Type.String({ description: "你建议的选项和理由" }),
	}),
	async execute(_id, p) {
		const md = `## 请示\n问题：${p.question}\n事实：${p.facts}\n选项：${p.options}\n建议：${p.recommendation}`;
		return done("已提交监工。本轮结束，等监工回复再继续。", md, true);
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerFlag("fast", { description: "OpenAI priority service tier", type: "boolean", default: false });
	pi.registerTool(stageReport);
	pi.registerTool(finalReport);
	pi.registerTool(askSupervisor);

	pi.on("before_provider_request", (event, ctx) => {
		if (!pi.getFlag("fast")) return undefined;
		if (!ctx.model?.provider?.startsWith("openai")) return undefined;
		return { ...(event.payload as object), service_tier: "priority" };
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			const file = String((event.input as { path?: unknown }).path ?? "");
			const why = writeGuard(file, ctx.cwd);
			if (!why) return undefined;
			return {
				block: true,
				reason: `${why}不要换别的方式改它；确实需要改，用 ask_supervisor 请示，由监工授权。`,
			};
		}
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (!GIT_WRITE.test(command)) return undefined;
		return {
			block: true,
			reason: "git 写操作由监工负责。只读 git（status/diff/log/show）可用；需要改分支或提交时在汇报里说明。",
		};
	});
}
