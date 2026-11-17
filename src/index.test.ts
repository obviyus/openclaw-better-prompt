import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "./index.ts";

type Handler = (action: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

// The plugin listens to agent events only while a run is active, keeps one run per chat, and
// hands the result only to the connection that started it.
test("one run per chat, agent events only while it runs, result only to its starter", async () => {
	const handlers = new Map<string, Handler>();
	const emitted: Array<{ runId: string; done: boolean; tools: unknown[] }> = [];
	let listeners = 0;
	let deliver: ((event: { runId: string; stream: string; data: Record<string, unknown> }) => void) | undefined;
	const fork = Promise.withResolvers<{ status: "settled"; runId: string; value: unknown }>();
	let forkParams: Record<string, unknown> | undefined;
	const api = {
		id: "better-prompt",
		registerService: (service: { start: (context: unknown) => void }) =>
			service.start({ gatewayEvents: { emit: (_event: string, payload: (typeof emitted)[number]) => emitted.push(payload) } }),
		session: { controls: { registerSessionAction: ({ id, handler }: { id: string; handler: Handler }) => handlers.set(id, handler) } },
		runtime: {
			config: { current: () => ({}) },
			agent: { resolveAgentWorkspaceDir: () => process.cwd() },
			events: {
				onAgentEvent: (listener: typeof deliver) => {
					listeners++;
					deliver = listener;
					return () => {
						listeners--;
						deliver = undefined;
					};
				},
			},
			subagent: {
				runForkedTurn: async (params: Record<string, unknown> & { onSettled: (outcome: unknown) => unknown }) => {
					forkParams = params;
					const settled = await fork.promise;
					return { ...settled, value: await params.onSettled(settled.value) };
				},
			},
		},
	};
	plugin.register(api as never);
	const call = (id: string, payload: unknown, connId = "window-1") =>
		handlers.get(id)!({ pluginId: "better-prompt", actionId: id, sessionKey: "agent:main:main", agentId: "main", payload, client: { connId, scopes: [] } });

	assert.equal(listeners, 0);
	const started = await call("start", { prompt: "make hover nicer" });
	assert.equal(started.ok, true);
	const { runId } = started.result as { runId: string };
	assert.equal(listeners, 1);
	assert.deepEqual(forkParams?.tools, ["read", "ls", "exec"]);
	assert.equal(forkParams?.timeoutMs, 20 * 60 * 1000);
	assert.match(String(forkParams?.prompt), /## Prompt to deepen\n\nmake hover nicer/);
	assert.deepEqual(await call("start", { prompt: "again" }), { ok: false, error: "/better is already running; Cancel stops it.", code: "OPERATION_FAILED" });

	// Only this run's events reach the rows.
	deliver?.({ runId: "someone-else", stream: "tool", data: { phase: "start", name: "read", toolCallId: "x", args: { path: "a" } } });
	deliver?.({ runId, stream: "tool", data: { phase: "start", name: "read", toolCallId: "y", args: { path: "b.ts" } } });
	assert.deepEqual(emitted.at(-1)?.tools, [{ label: "read b.ts", state: "running" }]);

	fork.resolve({ status: "settled", runId, value: { runId, ok: true, text: "(1) …\n\n<improved-prompt>\nBetter.\n</improved-prompt>" } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(listeners, 0);
	assert.equal(emitted.at(-1)?.done, true);
	assert.equal((await call("take", { runId }, "window-2")).ok, false);
	assert.deepEqual(await call("take", { runId }), { ok: true, result: { improved: "Better." } });
	assert.equal((await call("take", { runId })).ok, false);
});
