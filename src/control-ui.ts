import { defineControlUiPlugin, type ControlUiAction } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient, type FeatureEvent } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.ts";

type Progress = FeatureEvent<typeof contract, "progress">;
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

export default defineControlUiPlugin({
	id: contract.pluginId,
	activate(host) {
		// The helper runs in the Gateway, one per chat, so leaving the chat only retires the card.
		// Coming back attaches to the same run: the card returns with its clock and tools, and a
		// result that finished meanwhile is inserted (and sent, for "Better and send") then.
		async function follow(
			{ sessionKey, agentId, composer, host: actionHost, signal }: Context,
			send: boolean,
			prompt: string | undefined,
		) {
			if (!composer || !sessionKey) return;
			if (typeof composer.startTask !== "function") {
				throw new Error("Better needs a newer OpenClaw, with composer tasks. Update OpenClaw, then try again.");
			}
			const client = createFeatureClient(contract, actionHost);
			const target = { sessionKey, agentId };
			let run = await client.invoke("active", {}, target);
			// Attach shows only this button's own run; the other button attaches to its own.
			if (prompt === undefined && (!run.runId || run.send !== send)) return;
			if (!run.runId) {
				run = { ...(await client.invoke("start", { prompt: prompt ?? "", send }, target)), send };
			}
			const runId = run.runId;
			if (!runId) return;
			// The host shows the card, the clock, Cancel and the pressed icon from here on.
			const task = composer.startTask({ title: "Improving your prompt", startedAt: run.startedAt });
			if (run.progress) task.update({ summary: summary(run.progress), steps: steps(run.progress) });
			const finished = Promise.withResolvers<void>();
			if (run.progress?.done) finished.resolve();
			const stopProgress = client.on("progress", (progress) => {
				if (progress.sessionKey !== sessionKey || progress.runId !== runId) return;
				task.update({ summary: summary(progress), steps: steps(progress) });
				if (progress.done) finished.resolve();
			});
			// Cancel stops the helper; leaving the chat aborts `signal` too and keeps it running.
			task.signal.addEventListener(
				"abort",
				() => {
					if (!signal.aborted) void client.invoke("cancel", {}, target).catch(() => {});
				},
				{ once: true },
			);
			try {
				await Promise.race([
					finished.promise,
					new Promise((resolve) => task.signal.addEventListener("abort", resolve, { once: true })),
				]);
				if (task.signal.aborted) return;
				const result = await client.invoke("take", { runId }, target);
				if (result.improved) {
					// Replaces the draft at once as one undoable edit; with send, the composer then sends it.
					await task.propose(result.improved, { title: "Better rewrote your prompt", insert: true, send: run.send });
				} else if (!result.cancelled) {
					task.fail(result.error ?? "The helper failed without an error message.");
				}
			} catch (error) {
				if (!task.signal.aborted) task.fail(error instanceof Error ? error.message : String(error));
			} finally {
				stopProgress();
			}
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
