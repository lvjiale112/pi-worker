// 施工 worker 专用的 pi 扩展：--fast 走 OpenAI priority 档位；git 写操作留给监工；
// 同一检出里别的 worker 负责的文件不让写（认领清单由 piw 写在 $PIW_RUN_DIR/foreign.json）。
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_WRITE =
	/\bgit\s+(?:-C\s+\S+\s+)?(commit|push|pull|fetch|merge|rebase|reset|revert|checkout|switch|restore|clean|stash|cherry-pick|tag|branch\s+-[dDmM]|worktree|am|apply)\b/i;

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p).replaceAll("\\", "/");

// 与 piw.mjs 的 matches 同义：目录前缀或 * / ** 通配
function matches(rel: string, entry: string) {
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

type Foreign = { checkout: string; workers: { name: string; change: string[]; files: string[] }[] };

function ownerOf(file: string, cwd: string) {
	const dir = process.env.PIW_RUN_DIR;
	if (!dir) return undefined;
	let foreign: Foreign;
	try {
		foreign = JSON.parse(readFileSync(path.join(dir, "foreign.json"), "utf8"));
	} catch {
		return undefined;
	}
	const rel = norm(path.relative(foreign.checkout, path.resolve(cwd, file)));
	if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
	return foreign.workers.find((w) => w.change.some((e) => matches(rel, e)) || w.files.includes(rel))?.name;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("fast", { description: "OpenAI priority service tier", type: "boolean", default: false });

	pi.on("before_provider_request", (event, ctx) => {
		if (!pi.getFlag("fast")) return undefined;
		if (!ctx.model?.provider?.startsWith("openai")) return undefined;
		return { ...(event.payload as object), service_tier: "priority" };
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			const file = String((event.input as { path?: unknown }).path ?? "");
			const owner = ownerOf(file, ctx.cwd);
			if (!owner) return undefined;
			return {
				block: true,
				reason: `${file} 由同一工作区里在跑的 worker ${owner} 负责，同一文件只能有一个写入者。不要换别的方式改它；确实需要改，就在汇报的「待定」里说明，由监工协调。`,
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
