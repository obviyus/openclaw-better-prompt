import { Check } from "typebox/value";
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
	setup(api) {
		// One run per chat, as in pi-better; a finished result waits here until its starter takes it.
		const runs = new Map<string, Run>();
		const sessionOf = (context: FeatureInvocationContext) => {
			const sessionKey = context.source === "session-action" ? context.action.sessionKey : undefined;
			if (!sessionKey) throw new Error("/better runs from a chat's composer.");
			return sessionKey;
		};

		type Target = { sessionKey: string; agentId?: string; slot: string; signal?: AbortSignal };
		const legacy = (context: FeatureInvocationContext): Target => {
			const sessionKey = sessionOf(context);
			return { sessionKey, slot: JSON.stringify(["legacy", sessionKey]), agentId: context.source === "session-action" ? context.action.agentId : undefined };
		};
		function start({ prompt, send }: { prompt: string; send?: boolean }, target: Target) {
			const { sessionKey, slot } = target;
			const current = runs.get(slot);
			if (current && !current.result) {
				throw new Error("/better is already running; Cancel stops it.");
			}
			// Resolved before the run is registered, so a missing workspace fails here instead of
			// leaving /better stuck "already running" (as in pi-better).
			const projectDirs: string[] = [];
			if (target.agentId) {
				const config = api.runtime.config.current({ clone: true });
				const workspace = api.runtime.agent.resolveAgentWorkspaceDir(config, target.agentId);
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
			const update = (done: boolean) => {
				run.progress = { ...progress.snapshot(), done };
			};
			runs.set(slot, run);
			// Subscribed only while this run is active.
			const stopListening = api.runtime.events.onAgentEvent((event) => {
				if (event.runId === run.runId && progress.apply(event)) update(false);
			});
			const finished = api.runtime.subagent
				.runForkedTurn({
					sessionKey,
					prompt: buildHelperTask(helper, prompt.trim()),
					tools: target.signal ? ["read", "ls"] : HELPER_TOOLS,
					runId: run.runId,
					timeoutMs: HELPER_TIMEOUT_MS,
					signal: target.signal ? AbortSignal.any([target.signal, run.controller.signal]) : run.controller.signal,
					onSettled: (outcome) => outcome,
				})
				.then((settled): Result => {
					if (settled.status === "refused") {
						return { error: "The chat or requester policy did not allow this helper to read the session workspace." };
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
					update(true);
				});
			return { receipt: { runId: run.runId, startedAt: run.startedAt, token: run.token }, run, finished };
		}

		type Receipt = { runId: string; token: string };
		function owned(slot: string, receipt: Receipt) {
			const run = runs.get(slot);
			return run && run.runId === receipt.runId && run.token === receipt.token ? run : undefined;
		}
		function active(slot: string, receipt: Receipt) {
			const run = owned(slot, receipt);
			return run ? { runId: run.runId, startedAt: run.startedAt, send: run.send, progress: run.progress } : {};
		}
		function cancel(slot: string, receipt: Receipt) {
			const run = owned(slot, receipt);
			if (!run || run.result) return { cancelled: false };
			run.controller.abort();
			return { cancelled: true };
		}
		function take(slot: string, receipt: Receipt) {
			const run = owned(slot, receipt);
			if (!run) throw new Error("This /better run is unavailable.");
			if (!run.result) throw new Error("/better is still running.");
			runs.delete(slot);
			return run.result;
		}

		api.registerGatewayMethod("better-prompt.session.v1", ({ params, client, sessionAccessAuthority: auth, respond }) => {
			const profile = client?.authenticatedUserProfile?.profileId;
			if (!auth || !profile) {
				respond(false, undefined, { code: "FORBIDDEN", message: "Better requires an authenticated session writer." });
				return;
			}
			auth.assertCurrent();
			const { sessionKey, agentId, sessionId, lifecycleRevision } = auth.target;
			const slot = JSON.stringify(["person", profile, agentId, sessionKey, sessionId, lifecycleRevision ?? null]);
			const { op, input } = params;
			if (op === "start" && Check(contract.operations.start.input, input)) {
				const borrow = auth.retain();
				try {
					borrow.assertCurrent();
					const { receipt, run, finished } = start(input, { sessionKey, agentId, slot, signal: borrow.signal });
					// A session reset or revoked grant cannot leave an accessible result behind.
					const revoke = () => { if (runs.get(slot) === run) runs.delete(slot); };
					borrow.signal.addEventListener("abort", revoke, { once: true });
					void finished.finally(() => {
						borrow.signal.removeEventListener("abort", revoke);
						borrow.release();
						// A closed browser or reset chat may never come back to collect the result.
						setTimeout(revoke, HELPER_TIMEOUT_MS).unref();
					});
					auth.assertCurrent();
					respond(true, receipt);
				} catch (error) {
					borrow.release();
					throw error;
				}
				return;
			}
			if ((op === "active" || op === "cancel" || op === "take") && Check(contract.operations.take.input, input)) {
				respond(true, op === "active" ? active(slot, input) : op === "cancel" ? cancel(slot, input) : take(slot, input));
				return;
			}
			respond(false, undefined, { code: "INVALID_REQUEST", message: "Invalid Better operation or input." });
		}, { scope: "operator.write", profileAccess: "required", sessionAccess: { mode: "write", allowOwnSessionScope: true } });
		return {
			start: (input, context) => start(input, legacy(context)).receipt,
			active: (input, context) => active(legacy(context).slot, input),
			cancel: (input, context) => cancel(legacy(context).slot, input),
			take: (input, context) => take(legacy(context).slot, input),
		};
	},
});
