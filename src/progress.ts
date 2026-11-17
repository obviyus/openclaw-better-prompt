// pi-better's tool row (index.ts `HelperProgress`), fed by OpenClaw agent events. A session fork
// is silent, so its reply text never streams; only tool starts and results reach the plugin.
import { homedir } from "node:os";
import { basename } from "node:path";

export type ToolRow = { label: string; state: "running" | "ok" | "failed" };
export type ProgressSnapshot = { tools: ToolRow[]; toolCount: number; failedCount: number };
type AgentEvent = { stream: string; data: Record<string, unknown> };

// The browser shows the newest tools that fit; older ones only count.
const SHOWN_TOOLS = 12;

function shortPath(path: string, projectDirs: readonly string[]): string {
	for (const dir of projectDirs) {
		if (path === dir) return ".";
		if (path.startsWith(`${dir}/`)) return path.slice(dir.length + 1);
	}
	const home = homedir();
	if (path === home || path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path.startsWith("/") ? basename(path) : path;
}

export function toolLabel(name: string, args: unknown, projectDirs: readonly string[]): string {
	const field = (key: string) => {
		const value = args && typeof args === "object" && key in args ? Reflect.get(args, key) : undefined;
		return typeof value === "string" ? value : undefined;
	};
	let label = name;
	const command = field("command");
	if (name === "exec" && command !== undefined) {
		const parts = (command.match(/(?:'[^']*'|"[^"]*"|(?<!&)&(?!&)|[^'"|;&\n])+/g) ?? []).map((part) => part.trim().replace(/^(\w+=\S*\s+)+/, ""));
		const first = parts.find((part) => part && !/^(cd\s|\w+=\S*$)/.test(part)) ?? "";
		label = first.replace(/(?<![\w.~$>:/])\/(?!dev\/)[\w.@+-]+(?:\/[\w.@+-]*)*/g, (path) => shortPath(path, projectDirs));
	} else {
		const pathArg = field("path");
		const path = pathArg !== undefined ? shortPath(pathArg, projectDirs) : ".";
		const target = path === "." ? field("pattern") : path;
		if (target !== undefined) label = `${name} ${target}`;
	}
	// One row: a newline or tab in a command or pattern would make the row taller. The browser
	// truncates further; this bound keeps the event small.
	return (label.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim() || name).slice(0, 120);
}

/** Tracks one helper run; `apply` returns true when the rows changed. */
export function createProgress(projectDirs: readonly string[]) {
	const tools: (ToolRow & { id: string })[] = [];
	let failedCount = 0;
	return {
		apply(event: AgentEvent): boolean {
			const { data } = event;
			if (event.stream !== "tool" || typeof data.toolCallId !== "string") return false;
			if (data.phase === "start" && typeof data.name === "string") {
				tools.push({ id: data.toolCallId, label: toolLabel(data.name, data.args, projectDirs), state: "running" });
				return true;
			}
			const tool = tools.find((candidate) => candidate.id === data.toolCallId);
			if (data.phase !== "result" || tool?.state !== "running") return false;
			tool.state = data.isError === true ? "failed" : "ok";
			if (tool.state === "failed") failedCount++;
			return true;
		},
		snapshot(): ProgressSnapshot {
			return {
				tools: tools.slice(-SHOWN_TOOLS).map(({ label, state }) => ({ label, state })),
				toolCount: tools.length,
				failedCount,
			};
		},
	};
}
