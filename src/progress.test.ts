import assert from "node:assert/strict";
import { test } from "node:test";
import { createProgress } from "./progress.ts";

test("progress follows OpenClaw tool events like pi-better's tool row", () => {
	const progress = createProgress(["/work/app"]);
	assert.equal(progress.apply({ stream: "tool", data: { phase: "start", name: "exec", toolCallId: "a", args: { command: "cd /work/app && FOO=1 rg -n hover /work/app/src | head" } } }), true);
	assert.equal(progress.apply({ stream: "tool", data: { phase: "start", name: "read", toolCallId: "b", args: { path: "/work/app/src/hover.ts" } } }), true);
	assert.equal(progress.apply({ stream: "tool", data: { phase: "result", name: "exec", toolCallId: "a", isError: false } }), true);
	assert.equal(progress.apply({ stream: "tool", data: { phase: "result", name: "read", toolCallId: "b", isError: true } }), true);
	// A repeated result for a settled call, or an unrelated stream, changes nothing.
	assert.equal(progress.apply({ stream: "tool", data: { phase: "result", name: "read", toolCallId: "b", isError: false } }), false);
	assert.equal(progress.apply({ stream: "lifecycle", data: { phase: "start" } }), false);
	assert.deepEqual(progress.snapshot(), {
		tools: [
			{ label: "rg -n hover src", state: "ok" },
			{ label: "read src/hover.ts", state: "failed" },
		],
		toolCount: 2,
		failedCount: 1,
	});
});
