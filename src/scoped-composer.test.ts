import assert from "node:assert/strict";
import { test } from "node:test";
import type { ControlUiAction } from "openclaw/plugin-sdk/control-ui";
import plugin from "./control-ui.ts";

// Every caller, owner or session writer, uses the one session-scoped method; the result only
// goes through the composer, and a read-only rewrite says so.
const cases = [
	{ send: false, readOnly: false, title: "Better rewrote your prompt" },
	{ send: true, readOnly: false, title: "Better rewrote your prompt" },
	{ send: false, readOnly: true, title: "Better rewrote your prompt read-only: this chat did not let it run commands" },
];
for (const { send, readOnly, title } of cases) test(`composer: send=${send} readOnly=${readOnly}`, async () => {
	const actions = new Map<string, ControlUiAction>();
	const stored = new Map<string, string>();
	const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) } });
	try {
		const signal = new AbortController().signal;
		const calls: string[] = [];
		const proposals: unknown[] = [];
		const receipt = { runId: crypto.randomUUID(), token: crypto.randomUUID() };
		const host = {
			pluginId: "better-prompt", signal, connection: { connected: true, canWrite: true, canAdmin: true }, ui: { registerAction: (a: ControlUiAction) => actions.set(a.id, a) },
			request: async (method: string, p: { sessionKey: string; agentId: string; op: string; input: object }) => {
				assert.equal(method, "better-prompt.session.v1"); assert.equal(p.sessionKey, "agent:main:own"); assert.equal(p.agentId, "main"); calls.push(p.op);
				if (p.op === "start") { assert.deepEqual(p.input, { prompt: "my draft", send }); return { ...receipt, startedAt: 1 }; }
				assert.deepEqual(p.input, receipt);
				if (p.op === "active") return { runId: receipt.runId, progress: { done: true, tools: [], toolCount: 0, failedCount: 0 } };
				assert.equal(p.op, "take"); return { improved: "revised draft", ...(readOnly ? { readOnly } : {}) };
			},
		};
		await plugin.activate(host as never);
		const action = actions.get(send ? "better-send" : "better")!;
		const context = { host, sessionKey: "agent:main:own", agentId: "main", signal, composer: { draft: "my draft", startTask: () => ({ signal, update() {}, fail(message: string) { assert.fail(message); }, propose: (...args: unknown[]) => proposals.push(args) }) } };
		await action.attach?.(context as never); assert.deepEqual(calls, []);
		await action.run(context as never);
		assert.deepEqual(calls, ["start", "active", "take"]); assert.equal(stored.size, 0);
		assert.deepEqual(proposals, [["revised draft", { title, insert: true, send }]]);
	} finally { if (prior) Object.defineProperty(globalThis, "localStorage", prior); else Reflect.deleteProperty(globalThis, "localStorage"); }
});
