import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import plugin from "./index.ts";

type Settled = { status: "settled"; runId: string; value: unknown } | { status: "refused"; reason: "tool_policy" };
type Handler = (opts: Record<string, unknown>) => void;

// One session-scoped Gateway method serves every caller. Runs are private to the caller and
// chat incarnation the host admitted, and need the start receipt; nothing is broadcast.
function setup() {
	let method: { name: string; handler: Handler; options: unknown } | undefined;
	let listeners = 0;
	let deliver: ((event: { runId: string; stream: string; data: Record<string, unknown> }) => void) | undefined;
	const forks: Array<{ params: Record<string, unknown>; settle: (settled: Settled) => void }> = [];
	const api = {
		id: "better-prompt",
		registerGatewayMethod: (name: string, handler: Handler, options: unknown) => {
			method = { name, handler, options };
		},
		registerService: () => assert.fail("Better must not register a broadcasting service"),
		session: { controls: { registerSessionAction: () => assert.fail("Better has no session actions") } },
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
					const settled = Promise.withResolvers<Settled>();
					forks.push({ params, settle: settled.resolve });
					const result = await settled.promise;
					return result.status === "settled" ? { ...result, value: await params.onSettled(result.value) } : result;
				},
			},
		},
	};
	plugin.register(api as never);
	const request = (profile: string | undefined, incarnation: string, op: string, input: unknown, admitted = true) => {
		type Value = { runId: string; token: string; progress: { tools: unknown[] }; improved?: string; readOnly?: boolean; error: string; cancelled?: boolean };
		let output: { ok: boolean; value: Value; error: unknown } | undefined;
		method!.handler({
			params: { op, input },
			client: profile ? { authenticatedUserProfile: { profileId: profile } } : {},
			sessionAccessAuthority: admitted
				? {
						target: { agentId: "main", sessionKey: "agent:main:main", sessionId: incarnation },
						assertCurrent() {},
						retain: () => ({ signal: new AbortController().signal, assertCurrent() {}, release() {} }),
					}
				: undefined,
			respond: (ok: boolean, value: Value, error: unknown) => {
				output = { ok, value, error };
			},
		});
		return output!;
	};
	const flush = () => setImmediate();
	return { method: () => method!, request, forks, flush, listeners: () => listeners, deliver: (event: Parameters<NonNullable<typeof deliver>>[0]) => deliver?.(event) };
}

const reply = (runId: string) => ({ status: "settled" as const, runId, value: { runId, ok: true, text: "(1) …\n\n<improved-prompt>\nBetter.\n</improved-prompt>" } });

test("one own-session method; private progress, cancel and result per caller and incarnation", async () => {
	const { method, request, forks, flush, listeners, deliver } = setup();
	assert.equal(method().name, "better-prompt.session.v1");
	assert.deepEqual(method().options, { scope: "operator.write", profileAccess: "required", sessionAccess: { mode: "write", allowOwnSessionScope: true } });

	assert.equal(request("one", "first", "start", { prompt: "draft" }, false).ok, false);
	assert.equal(listeners(), 0);
	const started = request("one", "first", "start", { prompt: "make hover nicer" });
	assert.equal(started.ok, true);
	const held = { runId: started.value.runId, token: started.value.token };
	assert.equal(listeners(), 1);
	assert.deepEqual(forks[0].params.tools, ["read", "ls", "exec"]);
	assert.equal(forks[0].params.timeoutMs, 20 * 60 * 1000);
	assert.match(String(forks[0].params.prompt), /## Prompt to deepen\n\nmake hover nicer/);
	assert.throws(() => request("one", "first", "start", { prompt: "again" }), /already running/);

	// Only this run's events reach its rows, and only its holder reads them.
	deliver({ runId: "someone-else", stream: "tool", data: { phase: "start", name: "read", toolCallId: "x", args: { path: "a" } } });
	deliver({ runId: held.runId, stream: "tool", data: { phase: "start", name: "read", toolCallId: "y", args: { path: "b.ts" } } });
	assert.deepEqual(request("one", "first", "active", held).value.progress.tools, [{ label: "read b.ts", state: "running" }]);
	assert.deepEqual(request("one", "first", "active", { runId: held.runId, token: crypto.randomUUID() }).value, {});
	assert.deepEqual(request("two", "first", "active", held).value, {});
	assert.deepEqual(request("one", "replacement", "active", held).value, {});
	assert.deepEqual(request("two", "first", "cancel", held).value, { cancelled: false });

	forks[0].settle(reply(held.runId));
	await flush();
	assert.equal(listeners(), 0);
	assert.throws(() => request("two", "first", "take", held), /unavailable/);
	assert.throws(() => request("one", "first", "take", { runId: held.runId, token: crypto.randomUUID() }), /unavailable/);
	assert.deepEqual(request("one", "first", "take", held).value, { improved: "Better." });
	assert.throws(() => request("one", "first", "take", held), /unavailable/);
	assert.equal(request("one", "first", "nope", held).ok, false);
});

test("exec refused by the chat: the helper reruns read-only and says so", async () => {
	const { request, forks, flush } = setup();
	const started = request(undefined, "first", "start", { prompt: "draft" });
	const held = { runId: started.value.runId, token: started.value.token };
	forks[0].settle({ status: "refused", reason: "tool_policy" });
	await flush();
	assert.deepEqual(forks[1].params.tools, ["read", "ls"]);
	forks[1].settle(reply(held.runId));
	await flush();
	assert.deepEqual(request(undefined, "first", "take", held).value, { improved: "Better.", readOnly: true });
});

test("read and ls refused too: a clear error", async () => {
	const { request, forks, flush } = setup();
	const started = request("one", "first", "start", { prompt: "draft" });
	const held = { runId: started.value.runId, token: started.value.token };
	forks[0].settle({ status: "refused", reason: "tool_policy" });
	await flush();
	forks[1].settle({ status: "refused", reason: "tool_policy" });
	await flush();
	assert.match(request("one", "first", "take", held).value.error, /tool policy does not let Better's helper read files/);
});
