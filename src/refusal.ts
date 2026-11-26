// Plain messages for the errors core's forked turn throws. Each pattern matches a stable
// fragment of the core text (OpenClaw dde39b1), so it can be updated or removed when core
// changes. Better never passes `through`, so core's "reset or replaced" error is not mapped.
const PATTERNS: Array<{ match: RegExp; message: string }> = [
	{
		// openclaw src/gateway/server-plugin-forked-turn.ts lines 138 and 237
		match: /No active session context for/,
		message: "Better needs at least one message in this chat to work from.",
	},
	{
		// openclaw src/gateway/server-plugin-forked-turn.ts line 242
		match: /has no active entry "/,
		message: "This chat changed while Better was starting. Try again.",
	},
	{
		// openclaw src/gateway/server-plugin-forked-turn.ts line 250
		match: /no longer holds the input of entry/,
		message: "Better could not read this chat's latest message. Try again.",
	},
];

/** The plain message for a known fork error, or undefined to keep the caller's own handling. */
export function refusalMessage(error: unknown): string | undefined {
	const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return PATTERNS.find((pattern) => pattern.match.test(text))?.message;
}
