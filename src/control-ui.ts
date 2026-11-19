import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient, type FeatureEvent } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.ts";
import "./control-ui.css";

type Progress = FeatureEvent<typeof contract, "progress">;
// What the composer card shows for one chat. `holding` keeps the card through the hand-over
// to the host's proposal, so the composer never jumps between the two.
type View =
	| { kind: "starting"; startedAt: number }
	| { kind: "running"; progress: Progress }
	| { kind: "failed"; message: string };

const TITLE = "Better rewrote your prompt";
// Host icon artwork (pencilSparkles, alertTriangle), drawn by the plugin.
const ICONS = {
	sparkles: [
		"M10 3H8",
		"m15.007 5.008 3.987 3.986",
		"M20 15v4",
		"M21.174 6.813a2.82 2.82 0 0 0-3.986-3.987L3.842 16.175a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
		"M22 17h-4",
		"M4 5v4",
		"M6 7H2",
	],
	alert: ["m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
};

// A session fork is silent, so its reply never streams; the card shows only elapsed time.
function clock(startedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function icon(paths: readonly string[]): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	for (const [name, value] of Object.entries({
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": "2",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		"aria-hidden": "true",
	})) {
		svg.setAttribute(name, value);
	}
	for (const d of paths) {
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export default defineControlUiPlugin({
	id: contract.pluginId,
	activate(host) {
		const feature = createFeatureClient(contract, host);
		const views = new Map<string, View>();
		const holding = new Set<string>();
		const finished = new Set<string>();
		const waiters = new Map<string, () => void>();
		const renders = new Set<() => void>();
		const changed = () => {
			for (const render of renders) render();
			host.ui.invalidate();
		};
		const stopProgress = feature.on("progress", (progress) => {
			const view = views.get(progress.sessionKey);
			// Another window's run, or this window's run, both show; a failure stays until dismissed.
			if (progress.done) {
				finished.add(progress.runId);
				waiters.get(progress.runId)?.();
				if (!holding.has(progress.sessionKey) && view?.kind !== "failed") views.delete(progress.sessionKey);
			} else if (view?.kind !== "failed" || holding.has(progress.sessionKey)) {
				views.set(progress.sessionKey, { kind: "running", progress });
			}
			changed();
		});
		host.signal.addEventListener("abort", stopProgress, { once: true });
		const busy = (sessionKey: string | undefined) => {
			const view = sessionKey ? views.get(sessionKey) : undefined;
			return view?.kind === "starting" || view?.kind === "running";
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
		const cancel = (target: { sessionKey: string; agentId?: string }, client = feature) => {
			// Shown as stopped at once; the run's own result arrives later and changes nothing.
			holding.delete(target.sessionKey);
			views.delete(target.sessionKey);
			changed();
			return client.invoke("cancel", {}, target).catch(() => {});
		};
		const fail = (sessionKey: string, message: string) => {
			holding.delete(sessionKey);
			views.set(sessionKey, { kind: "failed", message });
			changed();
		};

		host.ui.registerAction({
			id: "better",
			label: "Better",
			icon: "pencilSparkles",
			placement: "composer",
			resolve: ({ sessionKey }) =>
				busy(sessionKey) ? { label: "Cancel Better", pressed: true } : { label: "Better", pressed: false },
			async run({ sessionKey, agentId, composer, signal, host: actionHost }) {
				if (!composer || !sessionKey) return;
				const client = createFeatureClient(contract, actionHost);
				const target = { sessionKey, agentId };
				if (busy(sessionKey)) {
					await cancel(target, client);
					return;
				}
				// The click is acknowledged in this frame, before the Gateway answers.
				views.set(sessionKey, { kind: "starting", startedAt: Date.now() });
				holding.add(sessionKey);
				changed();
				let runId: string;
				try {
					({ runId } = await client.invoke("start", { prompt: composer.draft }, target));
				} catch (error) {
					fail(sessionKey, error instanceof Error ? error.message : String(error));
					return;
				}
				// Leaving the chat stops the helper, as switching sessions does in pi-better.
				const stop = () => void cancel(target);
				signal.addEventListener("abort", stop, { once: true });
				try {
					await done(runId, signal);
				} finally {
					signal.removeEventListener("abort", stop);
					finished.delete(runId);
				}
				if (!holding.has(sessionKey)) return; // Cancelled meanwhile.
				let result: { improved?: string; error?: string; cancelled?: boolean };
				try {
					result = await client.invoke("take", { runId }, target);
				} catch (error) {
					fail(sessionKey, error instanceof Error ? error.message : String(error));
					return;
				}
				if (result.improved) {
					// Never sent and never typed over: the host offers it beside the draft. The card
					// leaves in the same task the proposal arrives, so the composer does not move.
					const outcome = composer.propose(result.improved, { title: TITLE });
					holding.delete(sessionKey);
					views.delete(sessionKey);
					changed();
					await outcome;
					return;
				}
				if (result.cancelled) {
					holding.delete(sessionKey);
					views.delete(sessionKey);
					changed();
					return;
				}
				fail(sessionKey, result.error ?? "The helper failed without an error message.");
			},
		});

		host.ui.registerAccessory({
			id: "better-progress",
			placement: "composer",
			mount(container, context) {
				let target = { sessionKey: context.props.sessionKey, agentId: context.props.agentId };
				const root = element("div", "better-prompt-progress");
				const head = element("div", "better-prompt-progress__head");
				const glyph = element("span", "better-prompt-progress__glyph");
				const title = element("span", "better-prompt-progress__title");
				const meta = element("span", "better-prompt-progress__clock");
				meta.setAttribute("aria-hidden", "true");
				const button = element("button", "btn btn--sm btn--ghost");
				button.type = "button";
				const body = element("div", "better-prompt-progress__tools");
				const status = element("span", "better-prompt-sr");
				status.setAttribute("role", "status");
				head.append(glyph, title, meta, button);
				root.append(head, body, status);
				container.append(root);
				let shown: View["kind"] | undefined;
				button.addEventListener("click", () => {
					const view = views.get(target.sessionKey);
					if (view?.kind === "failed") {
						views.delete(target.sessionKey);
						changed();
					} else {
						void cancel(target);
					}
				});
				const render = () => {
					const view = views.get(target.sessionKey);
					root.hidden = !view;
					if (!view) {
						shown = undefined;
						return;
					}
					root.dataset.state = view.kind === "failed" ? "failed" : "running";
					if (view.kind !== shown) {
						// Rebuilt only on a state change, so the screen reader hears each state once.
						shown = view.kind;
						glyph.replaceChildren(icon(view.kind === "failed" ? ICONS.alert : ICONS.sparkles));
						title.textContent = view.kind === "failed" ? "Better couldn't finish" : "Improving your prompt";
						title.classList.toggle("text-shimmer", view.kind !== "failed");
						button.textContent = view.kind === "failed" ? "Dismiss" : "Cancel";
						status.textContent =
							view.kind === "failed"
								? `Better couldn't finish: ${view.message} Your draft is unchanged.`
								: "Better is improving your prompt. It won't change your draft until you choose.";
					}
					if (view.kind === "failed") {
						meta.textContent = "your draft is unchanged";
						body.className = "better-prompt-progress__message";
						body.title = view.message;
						body.textContent = view.message;
						return;
					}
					const progress = view.kind === "running" ? view.progress : undefined;
					meta.textContent = clock(progress?.startedAt ?? (view.kind === "starting" ? view.startedAt : Date.now()));
					body.className = "better-prompt-progress__tools";
					body.removeAttribute("title");
					const count = element(
						"span",
						"better-prompt-progress__count",
						progress?.toolCount
							? `${progress.toolCount} tool${progress.toolCount === 1 ? "" : "s"}${progress.failedCount ? ` · ${progress.failedCount} failed` : ""}`
							: "Reading this chat",
					);
					const chips = (progress?.tools ?? []).toReversed().map(({ label, state }) => {
						const chip = element("span", "better-prompt-progress__tool");
						chip.dataset.state = state;
						chip.title = label;
						chip.append(element("i", "", state === "running" ? "•" : state === "ok" ? "✓" : "✗"), element("span", "", label));
						return chip;
					});
					body.replaceChildren(count, ...chips);
				};
				renders.add(render);
				const ticker = setInterval(() => busy(target.sessionKey) && render(), 1000);
				render();
				return {
					update(next) {
						target = { sessionKey: next.props.sessionKey, agentId: next.props.agentId };
						shown = undefined;
						render();
					},
					dispose() {
						clearInterval(ticker);
						renders.delete(render);
						root.remove();
					},
				};
			},
		});
	},
});
