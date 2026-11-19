import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient, type FeatureEvent } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.ts";

type Progress = FeatureEvent<typeof contract, "progress">;

// A session fork is silent, so its reply never streams: the card shows only the helper's tools.
function summary(progress: Progress): string {
	if (!progress.toolCount) return "Reading this chat";
	const tools = `${progress.toolCount} tool${progress.toolCount === 1 ? "" : "s"}`;
	return progress.failedCount ? `${tools} · ${progress.failedCount} failed` : tools;
}

export default defineControlUiPlugin({
	id: contract.pluginId,
	activate(host) {
		host.ui.registerAction({
			id: "better",
			label: "Better",
			icon: "pencilSparkles",
			placement: "composer",
			async run({ sessionKey, agentId, composer, host: actionHost }) {
				if (!composer || !sessionKey) return;
				const client = createFeatureClient(contract, actionHost);
				const target = { sessionKey, agentId };
				// The host shows the card, the clock, Cancel and the pressed icon from here on.
				const task = composer.startTask({ title: "Improving your prompt" });
				let runId: string | undefined;
				const finished = Promise.withResolvers<void>();
				const stopProgress = client.on("progress", (progress) => {
					// The first event can precede start's reply; it is this chat's only run.
					if (progress.sessionKey !== sessionKey || (runId && progress.runId !== runId)) return;
					task.update({
						summary: summary(progress),
						steps: progress.tools.map(({ label, state }) => ({ label, state: state === "ok" ? "done" : state })),
					});
					if (progress.done && progress.runId === runId) finished.resolve();
				});
				// Cancel, leaving the chat, or a reload stops the helper, as in pi-better.
				task.signal.addEventListener("abort", () => void client.invoke("cancel", {}, target).catch(() => {}), { once: true });
				try {
					({ runId } = await client.invoke("start", { prompt: composer.draft }, target));
					await Promise.race([
						finished.promise,
						new Promise((resolve) => task.signal.addEventListener("abort", resolve, { once: true })),
					]);
					if (task.signal.aborted) return;
					const result = await client.invoke("take", { runId }, target);
					if (result.improved) {
						// Never sent, never typed over: offered beside the draft, in the same card.
						await task.propose(result.improved, { title: "Better rewrote your prompt" });
					} else if (!result.cancelled) {
						task.fail(result.error ?? "The helper failed without an error message.");
					}
				} catch (error) {
					if (!task.signal.aborted) task.fail(error instanceof Error ? error.message : String(error));
				} finally {
					stopProgress();
				}
			},
		});
	},
});
