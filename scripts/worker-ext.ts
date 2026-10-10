// 施工 worker 专用的 pi 扩展：--fast 走 OpenAI priority 档位；git 写操作留给监工。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_WRITE =
	/\bgit\s+(?:-C\s+\S+\s+)?(commit|push|pull|fetch|merge|rebase|reset|revert|checkout|switch|restore|clean|stash|cherry-pick|tag|branch\s+-[dDmM]|worktree|am|apply)\b/i;

export default function (pi: ExtensionAPI) {
	pi.registerFlag("fast", { description: "OpenAI priority service tier", type: "boolean", default: false });

	pi.on("before_provider_request", (event, ctx) => {
		if (!pi.getFlag("fast")) return undefined;
		if (!ctx.model?.provider?.startsWith("openai")) return undefined;
		return { ...(event.payload as object), service_tier: "priority" };
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (!GIT_WRITE.test(command)) return undefined;
		return {
			block: true,
			reason: "git 写操作由监工负责。只读 git（status/diff/log/show）可用；需要改分支或提交时在汇报里说明。",
		};
	});
}
