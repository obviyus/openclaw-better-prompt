import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "./index.ts";

type Handler = (action: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

// The plugin listens to agent events only while a run is active, keeps one run per chat, and
// hands the result only to the holder of its start token, whichever connection that is.
test("one run per chat, agent events only while it runs, result only to its token", async () => {
	const handlers = new Map<string, Handler>();
	let scoped: ((opts: any) => void) | undefined;
	let scopedPolicy: unknown;
	const emitted: Array<{ runId: string; done: boolean; tools: unknown[] }> = [];
	let listeners = 0;
	let deliver: ((event: { runId: string; stream: string; data: Record<string, unknown> }) => void) | undefined;
	const fork = Promise.withResolvers<{ status: "settled"; runId: string; value: unknown }>();
	let forkParams: Record<string, unknown> | undefined;
	const api = {
		id: "better-prompt",
		registerGatewayMethod: (_: string, handler: NonNullable<typeof scoped>, options: unknown) => { scoped = handler; scopedPolicy = options; },
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
	const { runId, token } = started.result as { runId: string; token: string };
	assert.equal(listeners, 1);
	assert.deepEqual(forkParams?.tools, ["read", "ls", "exec"]);
	assert.equal(forkParams?.timeoutMs, 20 * 60 * 1000);
	assert.match(String(forkParams?.prompt), /## Prompt to deepen\n\nmake hover nicer/);
	assert.deepEqual(await call("start", { prompt: "again" }), { ok: false, error: "/better is already running; Cancel stops it.", code: "OPERATION_FAILED" });

	// Only this run's events reach the rows.
	deliver?.({ runId: "someone-else", stream: "tool", data: { phase: "start", name: "read", toolCallId: "x", args: { path: "a" } } });
	deliver?.({ runId, stream: "tool", data: { phase: "start", name: "read", toolCallId: "y", args: { path: "b.ts" } } });
	assert.deepEqual(emitted, []);
	const snapshot = (await call("active", { runId, token })).result as {progress: {tools: unknown[]}};
	assert.deepEqual(snapshot.progress.tools, [{ label: "read b.ts", state: "running" }]);
	assert.deepEqual((await call("active", { runId, token: crypto.randomUUID() })).result, {});
	assert.deepEqual((await call("cancel", { runId, token: crypto.randomUUID() })).result, {cancelled:false});

	fork.resolve({ status: "settled", runId, value: { runId, ok: true, text: "(1) …\n\n<improved-prompt>\nBetter.\n</improved-prompt>" } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(listeners, 0);
	assert.equal(emitted.length, 0);
	assert.equal((await call("take", { runId, token: "not-the-start-token" })).ok, false);
	// A reload is a new connection; the token still takes the result, once.
	assert.deepEqual(await call("take", { runId, token }, "window-2"), { ok: true, result: { improved: "Better." } });
	assert.equal((await call("take", { runId, token })).ok, false);

	assert.deepEqual(scopedPolicy, {scope:"operator.write", profileAccess:"required", sessionAccess:{mode:"write",allowOwnSessionScope:true}});
	const request = (profile: string, incarnation: string, op: string, input: unknown, admitted = true) => {
		let output: {ok: boolean; value: any} | undefined;
		scoped!({params:{op,input}, client:{authenticatedUserProfile:{profileId:profile}}, sessionAccessAuthority: admitted ? {
			target:{agentId:"main", sessionKey:"agent:main:main", sessionId:incarnation}, assertCurrent(){},
			retain(){ return {signal:new AbortController().signal, assertCurrent(){}, release(){}}; }
		}:undefined, respond:(ok: boolean,value: unknown)=>{output={ok,value};}});
		return output!;
	};
	assert.equal(request("one","first","start",{prompt:"draft"},false).ok,false);
	const privateRun = request("one","first","start",{prompt:"draft"});
	assert.equal(privateRun.ok,true);
	assert.deepEqual(forkParams?.tools,["read","ls"]);
	const held = {runId:privateRun.value.runId,token:privateRun.value.token};
	assert.ok(request("one","first","active",held).value.runId);
	assert.deepEqual(request("two","first","active",held).value,{});
	assert.deepEqual(request("one","replacement","active",held).value,{});
	assert.deepEqual(request("two","first","cancel",held).value,{cancelled:false});
	assert.throws(()=>request("two","first","take",held),/unavailable/);
	await new Promise((resolve)=>setImmediate(resolve));
	assert.deepEqual(request("one","first","take",held).value,{improved:"Better."});
	assert.equal(emitted.length,0);
});
