import { Check } from "typebox/value";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { buildHelperTask, parseMarkedPrompt } from "./better.ts";
import { METHOD, Receipt, StartInput, type Active, type Progress, type Result, type Started } from "./contract.ts";
import { createProgress } from "./progress.ts";

// pi-better's limits: the helper reads with read and ls and searches with the shell (exec).
// OpenClaw decides which of them this chat and caller may run.
const HELPER_TOOLS = ["read", "ls", "exec"];
const READ_TOOLS = ["read", "ls"];
const HELPER_TIMEOUT_MS = 20 * 60 * 1000;
// Shipped at the package root beside openclaw.plugin.json, unchanged from pi-better.
const helper = readFileSync(new URL("../helper.md", import.meta.url), "utf8");

type Run = {
	runId: string;
	/** Held by the browser that started the run; only it reads, cancels or takes it, across reloads. */
	token: string;
	controller: AbortController;
	startedAt: number;
	/** Started by "Better and send": its result is sent once inserted. */
	send: boolean;
	progress: Progress;
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
	// No feature operations: those are session actions that need general write. The contract only
	// gives `openclaw plugins build` the plugin's metadata; Better's one entry point is METHOD below.
	contract: defineFeatureContract({ pluginId: "better-prompt", operations: {}, events: {} }),
	name: "Better Prompt",
	description: "/better from pi-better: deepen a prompt on a read-only copy of the chat, then put it in the composer.",
	setup(api) {
		// One run per person and chat incarnation, as in pi-better; a finished result waits here
		// until its starter takes it.
		const runs = new Map<string, Run>();

		type Target = { sessionKey: string; agentId: string; slot: string; signal: AbortSignal };
		async function start({ prompt, send }: { prompt: string; send?: boolean }, target: Target) {
			const { sessionKey, slot } = target;
			const current = runs.get(slot);
			if (current && !current.result) {
				throw new Error("/better is already running; Cancel stops it.");
			}
			// Resolved before the run is registered, so a missing workspace fails here instead of
			// leaving /better stuck "already running" (as in pi-better).
			const config = api.runtime.config.current({ clone: true });
			const workspace = api.runtime.agent.resolveAgentWorkspaceDir(config, target.agentId);
			const progress = createProgress([workspace, realpathSync.native(workspace)]);
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
			// The fork's first agent event shows OpenClaw admitted it. Subscribed only while this run
			// is active.
			const admitted = Promise.withResolvers<void>();
			const stopListening = api.runtime.events.onAgentEvent((event) => {
				if (event.runId !== run.runId) return;
				admitted.resolve();
				if (progress.apply(event)) update(false);
			});
			const signal = AbortSignal.any([target.signal, run.controller.signal]);
			const fork = (tools: string[]) =>
				api.runtime.subagent.runForkedTurn({
					sessionKey,
					prompt: buildHelperTask(helper, prompt.trim()),
					tools,
					runId: run.runId,
					timeoutMs: HELPER_TIMEOUT_MS,
					signal,
					onSettled: (outcome) => outcome,
				});
			// OpenClaw admits exec only on the chat owner's own turns, and refuses before any model
			// call. Anyone else gets a read-only helper, and the composer says so. The second fork
			// must start while this request still holds the chat's admission.
			const first = fork(HELPER_TOOLS);
			const refused = await Promise.race([
				first.then((settled) => settled.status === "refused", () => false),
				admitted.promise.then(() => false),
			]);
			const finished = (refused ? fork(READ_TOOLS).then((settled) => ({ settled, readOnly: true })) : first.then((settled) => ({ settled, readOnly: false })))
				.then(({ settled, readOnly }): Result => {
					if (settled.status === "refused") {
						return { error: "This chat's tool policy does not let Better's helper read files (read and ls)." };
					}
					const outcome = settled.value;
					if (!outcome.ok) {
						return outcome.cancelled && run.controller.signal.aborted ? { cancelled: true } : { error: failure(outcome.error) };
					}
					if (!outcome.text?.trim()) return { error: "The helper finished without replying." };
					try {
						return { improved: parseMarkedPrompt(outcome.text), ...(readOnly ? { readOnly } : {}) };
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
			const started: Started = { runId: run.runId, startedAt: run.startedAt, token: run.token };
			return { started, run, finished };
		}

		function owned(slot: string, receipt: Receipt) {
			const run = runs.get(slot);
			return run && run.runId === receipt.runId && run.token === receipt.token ? run : undefined;
		}
		function active(slot: string, receipt: Receipt): Active {
			const run = owned(slot, receipt);
			return run ? { runId: run.runId, startedAt: run.startedAt, send: run.send, progress: run.progress } : {};
		}
		function cancel(slot: string, receipt: Receipt) {
			const run = owned(slot, receipt);
			if (!run || run.result) return { cancelled: false };
			run.controller.abort();
			return { cancelled: true };
		}
		function take(slot: string, receipt: Receipt): Result {
			const run = owned(slot, receipt);
			if (!run) throw new Error("This /better run is unavailable.");
			if (!run.result) throw new Error("/better is still running.");
			runs.delete(slot);
			return run.result;
		}

		api.registerGatewayMethod(
			METHOD,
			async ({ params, client, sessionAccessAuthority: auth, respond }) => {
				if (!auth) {
					respond(false, undefined, { code: "FORBIDDEN", message: "Better runs in a chat you can write to." });
					return;
				}
				auth.assertCurrent();
				// Chat, incarnation and caller come from the host, never from the browser.
				const { sessionKey, agentId, sessionId, lifecycleRevision } = auth.target;
				const profile = client?.authenticatedUserProfile?.profileId ?? null;
				const slot = JSON.stringify([profile, agentId, sessionKey, sessionId, lifecycleRevision ?? null]);
				const { op, input } = params;
				if (op === "start" && Check(StartInput, input)) {
					const borrow = auth.retain();
					try {
						borrow.assertCurrent();
						const { started, run, finished } = await start(input, { sessionKey, agentId, slot, signal: borrow.signal });
						// A session reset or revoked grant cannot leave an accessible result behind.
						const revoke = () => {
							if (runs.get(slot) === run) runs.delete(slot);
						};
						borrow.signal.addEventListener("abort", revoke, { once: true });
						void finished.finally(() => {
							borrow.signal.removeEventListener("abort", revoke);
							borrow.release();
							// A closed browser or reset chat may never come back to collect the result.
							setTimeout(revoke, HELPER_TIMEOUT_MS).unref();
						});
						auth.assertCurrent();
						respond(true, started);
					} catch (error) {
						borrow.release();
						throw error;
					}
					return;
				}
				if ((op === "active" || op === "cancel" || op === "take") && Check(Receipt, input)) {
					respond(true, op === "active" ? active(slot, input) : op === "cancel" ? cancel(slot, input) : take(slot, input));
					return;
				}
				respond(false, undefined, { code: "INVALID_REQUEST", message: "Invalid Better operation or input." });
			},
			{ scope: "operator.write", profileAccess: "required", sessionAccess: { mode: "write", allowOwnSessionScope: true } },
		);
		return {};
	},
});
