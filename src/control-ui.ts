import { defineControlUiPlugin, type ControlUiAction } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient, type FeatureInput, type FeatureOutput, type FeatureOperationName } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.ts";

type Progress = NonNullable<FeatureOutput<typeof contract, "active">["progress"]>;
type Receipt = FeatureInput<typeof contract, "take">;
type Context = Parameters<ControlUiAction["run"]>[0];
type Snapshot = Pick<Progress, "tools" | "toolCount" | "failedCount">;

// A session fork is silent, so its reply never streams: the card shows only the helper's tools.
function summary(progress: Snapshot): string {
	if (!progress.toolCount) return "Reading this chat";
	const tools = `${progress.toolCount} tool${progress.toolCount === 1 ? "" : "s"}`;
	return progress.failedCount ? `${tools} · ${progress.failedCount} failed` : tools;
}

const steps = (progress: Snapshot) =>
	progress.tools.map(({ label, state }) => ({ label, state: state === "ok" ? ("done" as const) : state }));

// The browser that started a run keeps its take token, so a reload or a second tab here can
// still collect the result; another browser or device never can.
const tokens = {
	key: (sessionKey: string) => `better-prompt:${sessionKey}`,
	get(sessionKey: string) {
		try {
			const held = JSON.parse(localStorage.getItem(this.key(sessionKey)) ?? "null") as { runId?: string; token?: string } | null;
			return held && typeof held.runId === "string" && typeof held.token === "string" ? { runId: held.runId, token: held.token } : undefined;
		} catch {
			return undefined;
		}
	},
	set(sessionKey: string, runId: string, token: string) {
		localStorage.setItem(this.key(sessionKey), JSON.stringify({ runId, token }));
	},
	clear(sessionKey: string) {
		localStorage.removeItem(this.key(sessionKey));
	},
};
function transport(host: Context["host"]) {
	const legacy = createFeatureClient(contract, host);
	return { invoke<K extends FeatureOperationName<typeof contract>>(op: K, input: FeatureInput<typeof contract, K>, target: { sessionKey: string; agentId?: string }): Promise<FeatureOutput<typeof contract, K>> {
		// This only selects a transport. Both are independently authorized by the Gateway.
		return host.connection.canWrite || host.connection.canAdmin ? legacy.invoke(op, input, target)
			: host.request("better-prompt.session.v1", { ...target, op, input });
	} };
}

async function waitForRun(client: ReturnType<typeof transport>, target: {sessionKey: string; agentId?: string}, receipt: Receipt,
	signal: AbortSignal, update?: (p: Progress) => void) {
	while (!signal.aborted) {
		let run: FeatureOutput<typeof contract, "active">;
		try { run = await client.invoke("active", receipt, target); } catch (error) { if (signal.aborted) return; throw error; }
		if (signal.aborted) return;
		if (!run.runId) throw new Error("This /better run is unavailable.");
		if (run.progress) update?.(run.progress);
		if (run.progress?.done) return;
		await new Promise<void>((resolve) => {
			const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
			const timer = setTimeout(finish, 1000);
			signal.addEventListener("abort", finish, { once: true });
		});
	}
}
export default defineControlUiPlugin({
	id: contract.pluginId,
	activate(host) {
		// The helper runs in the Gateway, one per chat, so leaving the chat only retires the card.
		// Coming back attaches to the same run: the card returns with its clock and tools, and a
		// Better result that finished meanwhile is inserted then. "Better and send" does not wait for
		// the return: this browser sends its result while you are on another page. With the tab
		// closed, nothing runs here, so the result is inserted and sent when the chat opens again.
		const away = new Map<string, AbortController>();
		// What a send while away did, shown when its chat opens again.
		const awayOutcomes = new Map<string, { sent: true } | { improved?: string; error: string }>();
		const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

		async function follow(
			{ sessionKey, agentId, composer, host: actionHost, signal }: Context,
			send: boolean,
			prompt: string | undefined,
		) {
			if (!composer || !sessionKey) return;
			if (typeof composer.startTask !== "function") {
				throw new Error("Better needs a newer OpenClaw, with composer tasks. Update OpenClaw, then try again.");
			}
			const client = transport(actionHost);
			const target = { sessionKey, agentId };
			const outcome = prompt === undefined ? awayOutcomes.get(sessionKey) : undefined;
			if (outcome) {
				awayOutcomes.delete(sessionKey);
				if ("sent" in outcome) {
					// The draft this browser improved was sent; the composer starts empty, as after Enter.
					composer.setDraft("");
					return;
				}
				const task = composer.startTask({ title: "Improving your prompt" });
				if (outcome.improved) {
					await task.propose(outcome.improved, { title: `Not sent: ${outcome.error}`, insert: true });
				} else {
					task.fail(outcome.error);
				}
				return;
			}
			const held = tokens.get(sessionKey);
			if (!held && prompt === undefined) return;
			let run: FeatureOutput<typeof contract, "active"> = held ? await client.invoke("active", held, target) : {};
			let token = run.runId === held?.runId ? held?.token : undefined;
			if (prompt === undefined) {
				// Attach shows only this button's own run, and only in the browser that started it.
				if (!run.runId || run.send !== send || !token) return;
			} else if (!run.runId || run.progress?.done || !token) {
				// A click starts fresh unless this browser's run is still working; then it shows that.
				const started = await client.invoke("start", { prompt, send }, target);
				tokens.set(sessionKey, started.runId, started.token);
				token = started.token;
				run = { runId: started.runId, startedAt: started.startedAt, send };
			}
			const runId = run.runId;
			if (!runId || !token) return;
			// Coming back takes over a send that was waiting while away.
			away.get(sessionKey)?.abort();
			// The host shows the card, the clock, Cancel and the pressed icon from here on.
			const task = composer.startTask({ title: "Improving your prompt", startedAt: run.startedAt });
			if (run.progress) task.update({ summary: summary(run.progress), steps: steps(run.progress) });
			const receipt = { runId, token };
			// Cancel stops the helper; leaving the chat aborts `signal` too and keeps it running.
			task.signal.addEventListener(
				"abort",
				() => {
					if (!signal.aborted) void client.invoke("cancel", receipt, target).catch(() => {});
				},
				{ once: true },
			);
			try {
				await waitForRun(client, target, receipt, task.signal, (progress) => {
					task.update({ summary: summary(progress), steps: steps(progress) });
				});
				if (task.signal.aborted) {
					if (signal.aborted && run.send) sendWhenDone(target, runId, token);
					return;
				}
				const result = await client.invoke("take", { runId, token }, target);
				tokens.clear(sessionKey);
				if (result.improved) {
					// Replaces the draft at once as one undoable edit; with send, the composer then sends it.
					await task.propose(result.improved, { title: "Better rewrote your prompt", insert: true, send: run.send });
				} else if (!result.cancelled) {
					task.fail(result.error ?? "The helper failed without an error message.");
				}
			} catch (error) {
				if (!task.signal.aborted) task.fail(message(error));
			}
		}

		// Left the chat during "Better and send": send the result as the composer would, with the
		// session's own model and effort, keyed by the run so the Gateway admits it once. This uses
		// the plugin's own host: the chat action's host stops events and calls once the chat closes.
		// Accepted: coming back in the moment between the take and the send can show a failed card
		// while the send still lands.
		function sendWhenDone(target: { sessionKey: string; agentId?: string }, runId: string, token: string) {
			const { sessionKey } = target;
			const client = transport(host);
			const stop = new AbortController();
			away.set(sessionKey, stop);
			void waitForRun(client, target, { runId, token }, stop.signal)
				.then(async () => {
					if (stop.signal.aborted) return;
					const result = await client.invoke("take", { runId, token }, target);
					tokens.clear(sessionKey);
					if (!result.improved) {
						if (!result.cancelled) awayOutcomes.set(sessionKey, { error: result.error ?? "The helper failed without an error message." });
						return;
					}
					try {
						await host.request("chat.send", { ...target, message: result.improved, idempotencyKey: `${runId}:send` });
						awayOutcomes.set(sessionKey, { sent: true });
					} catch (error) {
						awayOutcomes.set(sessionKey, { improved: result.improved, error: message(error) });
					}
				})
				.catch((error: unknown) => awayOutcomes.set(sessionKey, { error: message(error) }))
				.finally(() => {
					if (away.get(sessionKey) === stop) away.delete(sessionKey);
				});
		}

		// "Better and send" runs the same helper, then sends the result as Enter would.
		const register = (id: string, label: string, icon: string, send: boolean) =>
			host.ui.registerAction({
				id,
				label,
				icon,
				placement: "composer",
				// Better deepens what you typed, so it waits for a draft, like the send button.
				// A host without the draft in resolve stays enabled, so the click explains what is missing.
				resolve: ({ draft }) =>
					draft === undefined || draft.trim() ? {} : { disabled: true, label: `${label}: type a prompt first` },
				run: (context) => follow(context, send, context.composer?.draft ?? ""),
				attach: (context) => follow(context, send, undefined),
			});
		register("better", "Better", "pencilSparkles", false);
		register("better-send", "Better and send", "zap", true);
	},
});
