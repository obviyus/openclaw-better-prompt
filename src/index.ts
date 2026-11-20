import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { defineFeaturePlugin, type FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import { buildHelperTask, parseMarkedPrompt } from "./better.ts";
import { contract } from "./contract.ts";
import { createProgress } from "./progress.ts";

// pi-better's limits: the helper reads with read and ls and searches with the shell (exec);
// OpenClaw lists every session tool for the cache and refuses the rest when called.
const HELPER_TOOLS = ["read", "ls", "exec"];
const HELPER_TIMEOUT_MS = 20 * 60 * 1000;
// Shipped at the package root beside openclaw.plugin.json, unchanged from pi-better.
const helper = readFileSync(new URL("../helper.md", import.meta.url), "utf8");

type Result = { improved?: string; error?: string; cancelled?: boolean };
type Snapshot = ReturnType<ReturnType<typeof createProgress>["snapshot"]>;
type Run = {
	runId: string;
	/** Held by the browser that started the run; only it takes the result, across reloads. */
	token: string;
	controller: AbortController;
	startedAt: number;
	/** Started by "Better and send": its result is sent once inserted. */
	send: boolean;
	progress: Snapshot & { done: boolean };
	result?: Result;
};

function failure(error: unknown): string {
	const outcome = error && typeof error === "object" ? Reflect.get(error, "terminalOutcome") : undefined;
	if (outcome && typeof outcome === "object" && Reflect.get(outcome, "status") === "timeout") {
		return `The helper timed out after ${HELPER_TIMEOUT_MS / 60_000} minutes; try a narrower prompt.`;
	}
	const message = error instanceof Error ? error.message : String(error);
	return message.trim() || "The helper failed without an error message.";
}

export default defineFeaturePlugin({
	contract,
	name: "Better Prompt",
	description: "/better from pi-better: deepen a prompt on a read-only copy of the chat, then put it in the composer.",
	setup(api, events) {
		// One run per chat, as in pi-better; a finished result waits here until its starter takes it.
		const runs = new Map<string, Run>();
		const sessionOf = (context: FeatureInvocationContext) => {
			const sessionKey = context.source === "session-action" ? context.action.sessionKey : undefined;
			if (!sessionKey) throw new Error("/better runs from a chat's composer.");
			return sessionKey;
		};

		async function start({ prompt, send }: { prompt: string; send?: boolean }, context: FeatureInvocationContext) {
			const sessionKey = sessionOf(context);
			const current = runs.get(sessionKey);
			if (current && !current.result) {
				throw new Error("/better is already running; Cancel stops it.");
			}
			const action = context.source === "session-action" ? context.action : undefined;
			// Resolved before the run is registered, so a missing workspace fails here instead of
			// leaving /better stuck "already running" (as in pi-better).
			const projectDirs: string[] = [];
			if (action?.agentId) {
				const config = api.runtime.config.current({ clone: true });
				const workspace = api.runtime.agent.resolveAgentWorkspaceDir(config, action.agentId);
				projectDirs.push(workspace, realpathSync.native(workspace));
			}
			const progress = createProgress(projectDirs);
			const run: Run = {
				runId: `better-prompt:${randomUUID()}`,
				token: randomUUID(),
				controller: new AbortController(),
				startedAt: Date.now(),
				send: send === true,
				progress: { ...progress.snapshot(), done: false },
			};
			// The latest snapshot stays on the run, so a returning composer shows the same card.
			const publish = (done: boolean) => {
				run.progress = { ...progress.snapshot(), done };
				events.emit("progress", { sessionKey, runId: run.runId, startedAt: run.startedAt, ...run.progress });
			};
			// First, so an unavailable event service fails the start before anything is registered.
			publish(false);
			runs.set(sessionKey, run);
			// Subscribed only while this run is active.
			const stopListening = api.runtime.events.onAgentEvent((event) => {
				if (event.runId === run.runId && progress.apply(event)) publish(false);
			});
			void api.runtime.subagent
				.runForkedTurn({
					sessionKey,
					prompt: buildHelperTask(helper, prompt.trim()),
					tools: HELPER_TOOLS,
					runId: run.runId,
					timeoutMs: HELPER_TIMEOUT_MS,
					signal: run.controller.signal,
					onSettled: (outcome) => outcome,
				})
				.then((settled): Result => {
					if (settled.status === "refused") {
						return { error: "This chat's tool policy does not allow read, ls and exec, so the helper cannot read your files." };
					}
					const outcome = settled.value;
					if (!outcome.ok) {
						return outcome.cancelled && run.controller.signal.aborted ? { cancelled: true } : { error: failure(outcome.error) };
					}
					if (!outcome.text?.trim()) return { error: "The helper finished without replying." };
					try {
						return { improved: parseMarkedPrompt(outcome.text) };
					} catch (error) {
						return { error: `${failure(error)} The helper's whole reply was:\n\n${outcome.text}` };
					}
				}, (error: unknown): Result => ({ error: failure(error) }))
				.then((result) => {
					run.result = result;
				})
				.finally(() => {
					stopListening();
					publish(true);
				});
			return { runId: run.runId, startedAt: run.startedAt, token: run.token };
		}

		return {
			start,
			active: (_input, context) => {
				const run = runs.get(sessionOf(context));
				return run ? { runId: run.runId, startedAt: run.startedAt, send: run.send, progress: run.progress } : {};
			},
			cancel: (_input, context) => {
				const run = runs.get(sessionOf(context));
				if (!run || run.result) return { cancelled: false };
				run.controller.abort();
				return { cancelled: true };
			},
			take: ({ runId, token }, context) => {
				const sessionKey = sessionOf(context);
				const run = runs.get(sessionKey);
				if (!run || run.runId !== runId) throw new Error("This /better run is no longer here.");
				if (!run.result) throw new Error("/better is still running.");
				if (run.token !== token) throw new Error("Only the browser that started /better can take its result.");
				runs.delete(sessionKey);
				return run.result;
			},
		};
	},
});
