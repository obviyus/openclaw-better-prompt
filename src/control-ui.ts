import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient, type FeatureEvent } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.ts";
import "./control-ui.css";

type Progress = FeatureEvent<typeof contract, "progress">;

// A session fork is silent, so its reply never streams; the top row shows only elapsed time.
function clock(startedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export default defineControlUiPlugin({
	id: contract.pluginId,
	activate(host) {
		const feature = createFeatureClient(contract, host);
		// Latest progress per chat, from any window; finished runs by id for a late listener.
		const latest = new Map<string, Progress>();
		const finished = new Set<string>();
		const waiters = new Map<string, () => void>();
		const views = new Set<() => void>();
		const stopProgress = feature.on("progress", (progress) => {
			latest.set(progress.sessionKey, progress);
			if (progress.done) {
				finished.add(progress.runId);
				waiters.get(progress.runId)?.();
			}
			for (const render of views) render();
			host.ui.invalidate();
		});
		host.signal.addEventListener("abort", stopProgress, { once: true });
		const running = (sessionKey: string | undefined) => {
			const progress = sessionKey ? latest.get(sessionKey) : undefined;
			return progress !== undefined && !progress.done;
		};
		const done = (runId: string, signal: AbortSignal): Promise<void> => {
			if (finished.has(runId)) return Promise.resolve();
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const onAbort = () => {
				waiters.delete(runId);
				reject(signal.reason);
			};
			waiters.set(runId, () => {
				waiters.delete(runId);
				signal.removeEventListener("abort", onAbort);
				resolve();
			});
			signal.addEventListener("abort", onAbort, { once: true });
			return promise;
		};

		host.ui.registerAction({
			id: "better",
			label: "Better",
			placement: "composer",
			resolve: ({ sessionKey }) => ({ label: running(sessionKey) ? "Cancel" : "Better" }),
			async run({ sessionKey, agentId, composer, signal, host: actionHost }) {
				if (!composer || !sessionKey) return;
				const client = createFeatureClient(contract, actionHost);
				const target = { sessionKey, agentId };
				if (running(sessionKey)) {
					await client.invoke("cancel", {}, target);
					return;
				}
				const { runId } = await client.invoke("start", { prompt: composer.draft }, target);
				// Leaving the chat stops the helper, as switching sessions does in pi-better.
				const stop = () => void feature.invoke("cancel", {}, target).catch(() => {});
				signal.addEventListener("abort", stop, { once: true });
				await done(runId, signal);
				signal.removeEventListener("abort", stop);
				finished.delete(runId);
				const result = await client.invoke("take", { runId }, target);
				if (result.improved) {
					const draft = composer.draft.trim();
					// Never sent: the improved prompt goes above anything typed meanwhile.
					composer.setDraft(draft ? `${result.improved}\n\n${draft}` : result.improved);
					return;
				}
				throw new Error(result.cancelled ? "/better cancelled; nothing was sent." : `/better failed: ${result.error}`);
			},
		});

		host.ui.registerAccessory({
			id: "better-progress",
			placement: "session-header",
			mount(container, context) {
				let sessionKey = context.props.sessionKey;
				const root = document.createElement("div");
				root.className = "better-prompt-progress";
				root.setAttribute("role", "status");
				root.setAttribute("aria-live", "polite");
				const top = document.createElement("div");
				const bottom = document.createElement("div");
				root.append(top, bottom);
				container.append(root);
				const render = () => {
					const progress = latest.get(sessionKey);
					root.hidden = !progress || progress.done;
					if (!progress || progress.done) return;
					top.textContent = `Reading your code and files · ${clock(progress.startedAt)}`;
					const failed = progress.failedCount ? ` · ${progress.failedCount} failed` : "";
					const count = `${progress.toolCount} tool${progress.toolCount === 1 ? "" : "s"}${failed}`;
					const chips = progress.tools.map(
						({ label, state }) => `${state === "running" ? "•" : state === "ok" ? "✓" : "✗"} ${label}`,
					);
					bottom.textContent = chips.length ? `${chips.join("  ")}  ·  ${count}` : "no tools yet";
				};
				views.add(render);
				const ticker = setInterval(render, 1000);
				render();
				return {
					update(next) {
						sessionKey = next.props.sessionKey;
						render();
					},
					dispose() {
						clearInterval(ticker);
						views.delete(render);
						root.remove();
					},
				};
			},
		});
	},
});
