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
	const request = async (profile: string | undefined, incarnation: string, op: string, input: unknown, admitted = true) => {
		type Value = { runId: string; token: string; progress: { tools: unknown[] }; improved?: string; readOnly?: boolean; error: string; cancelled?: boolean };
		let output: { ok: boolean; value: Value; error: unknown } | undefined;
		await method!.handler({
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
	const lifecycle = (runId: string) => deliver?.({ runId, stream: "lifecycle", data: { phase: "start" } });
	return { method: () => method!, request, forks, flush, lifecycle, listeners: () => listeners, deliver: (event: Parameters<NonNullable<typeof deliver>>[0]) => deliver?.(event) };
}

const reply = (runId: string) => ({ status: "settled" as const, runId, value: { runId, ok: true, text: "(1) …\n\n<improved-prompt>\nBetter.\n</improved-prompt>" } });

test("one own-session method; private progress, cancel and result per caller and incarnation", async () => {
	const { method, request, forks, flush, lifecycle, listeners, deliver } = setup();
	assert.equal(method().name, "better-prompt.session.v1");
	assert.deepEqual(method().options, { scope: "operator.write", profileAccess: "required", sessionAccess: { mode: "write", allowOwnSessionScope: true } });

	assert.equal((await request("one", "first", "start", { prompt: "draft" }, false)).ok, false);
	assert.equal(listeners(), 0);
	const pending = request("one", "first", "start", { prompt: "make hover nicer" });
	await flush();
	assert.equal(listeners(), 1);
	assert.deepEqual(forks[0].params.tools, ["read", "ls", "exec"]);
	assert.equal(forks[0].params.timeoutMs, 20 * 60 * 1000);
	assert.match(String(forks[0].params.prompt), /## Prompt to deepen\n\nmake hover nicer/);
	// The start answers once OpenClaw admitted the fork.
	lifecycle(String(forks[0].params.runId));
	const started = await pending;
	assert.equal(started.ok, true);
	const held = { runId: started.value.runId, token: started.value.token };
	await assert.rejects(request("one", "first", "start", { prompt: "again" }), /already running/);

	// Only this run's events reach its rows, and only its holder reads them.
	deliver({ runId: "someone-else", stream: "tool", data: { phase: "start", name: "read", toolCallId: "x", args: { path: "a" } } });
	deliver({ runId: held.runId, stream: "tool", data: { phase: "start", name: "read", toolCallId: "y", args: { path: "b.ts" } } });
	assert.deepEqual((await request("one", "first", "active", held)).value.progress.tools, [{ label: "read b.ts", state: "running" }]);
	assert.deepEqual((await request("one", "first", "active", { runId: held.runId, token: crypto.randomUUID() })).value, {});
	assert.deepEqual((await request("two", "first", "active", held)).value, {});
	assert.deepEqual((await request("one", "replacement", "active", held)).value, {});
	assert.deepEqual((await request("two", "first", "cancel", held)).value, { cancelled: false });

	forks[0].settle(reply(held.runId));
	await flush();
	assert.equal(listeners(), 0);
	await assert.rejects(request("two", "first", "take", held), /unavailable/);
	await assert.rejects(request("one", "first", "take", { runId: held.runId, token: crypto.randomUUID() }), /unavailable/);
	assert.deepEqual((await request("one", "first", "take", held)).value, { improved: "Better." });
	await assert.rejects(request("one", "first", "take", held), /unavailable/);
	assert.equal((await request("one", "first", "nope", held)).ok, false);
	assert.equal(forks.length, 1);
});

test("exec refused: the read-only helper starts within the same request and says so", async () => {
	const { request, forks, flush } = setup();
	const pending = request(undefined, "first", "start", { prompt: "draft" });
	await flush();
	forks[0].settle({ status: "refused", reason: "tool_policy" });
	const started = await pending;
	// Started before the start answered, while the request still held the chat's admission.
	assert.deepEqual(forks[1].params.tools, ["read", "ls"]);
	const held = { runId: started.value.runId, token: started.value.token };
	forks[1].settle(reply(held.runId));
	await flush();
	assert.deepEqual((await request(undefined, "first", "take", held)).value, { improved: "Better.", readOnly: true });
});

test("read and ls refused too: a clear error", async () => {
	const { request, forks, flush } = setup();
	const pending = request("one", "first", "start", { prompt: "draft" });
	await flush();
	forks[0].settle({ status: "refused", reason: "tool_policy" });
	const started = await pending;
	const held = { runId: started.value.runId, token: started.value.token };
	forks[1].settle({ status: "refused", reason: "tool_policy" });
	await flush();
	assert.match((await request("one", "first", "take", held)).value.error, /tool policy does not let Better's helper read files/);
});

test("a core fork error shows the plain message", async () => {
	const { request, forks, flush } = setup();
	const key = "agent:main:dashboard:118d4675-b4f2-452e-8558-081098b3954c";
	const pending = request("one", "first", "start", { prompt: "draft" });
	await flush();
	// The fake queues the fork until settled; make the call reject like core does.
	forks[0].settle(Promise.reject(new Error(`No active session context for "${key}".`)) as never);
	const started = await pending;
	const held = { runId: started.value.runId, token: started.value.token };
	await flush();
	assert.equal(
		(await request("one", "first", "take", held)).value.error,
		"Better needs at least one message in this chat to work from.",
	);
});
