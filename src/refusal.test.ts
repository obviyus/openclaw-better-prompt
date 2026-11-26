import assert from "node:assert/strict";
import { test } from "node:test";
import { refusalMessage } from "./refusal.ts";

const key = "agent:main:dashboard:118d4675-b4f2-452e-8558-081098b3954c";
const entry = "9f2c1a7e";

test("no active session context: says the chat has no messages", () => {
	assert.equal(
		refusalMessage(new Error(`No active session context for "${key}".`)),
		"Better needs at least one message in this chat to work from.",
	);
});

test("reset or replaced is not mapped: Better never passes through", () => {
	assert.equal(refusalMessage(new Error(`Session "${key}" was reset or replaced after the requested entry.`)), undefined);
});

test("no active entry: try again", () => {
	assert.equal(
		refusalMessage(new Error(`Session "${key}" has no active entry "${entry}".`)),
		"This chat changed while Better was starting. Try again.",
	);
});

test("input compacted away: says Better could not read it", () => {
	assert.equal(
		refusalMessage(new Error(`Session "${key}" no longer holds the input of entry "${entry}".`)),
		"Better could not read this chat's latest message. Try again.",
	);
});

test("other errors and non-errors are left alone", () => {
	assert.equal(refusalMessage(new Error("boom")), undefined);
	assert.equal(refusalMessage("nope"), undefined);
	assert.equal(refusalMessage(undefined), undefined);
});
