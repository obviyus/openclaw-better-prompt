import { Type, type Static } from "typebox";
import type { ToolRow } from "./progress.ts";

/**
 * The one Gateway method. The host admits it only for an existing chat the caller may write to
 * (own-session write access) and passes that chat, its incarnation and the caller to the plugin.
 */
export const METHOD = "better-prompt.session.v1";

const RunId = Type.String({ minLength: 1, maxLength: 200 });
const Token = Type.String({ minLength: 16, maxLength: 200 });

export const StartInput = Type.Object(
	{ prompt: Type.String({ maxLength: 100_000 }), send: Type.Optional(Type.Boolean()) },
	{ additionalProperties: false },
);
/** Held by the browser that started the run; only it reads, cancels or takes the run. */
export const Receipt = Type.Object({ runId: RunId, token: Token }, { additionalProperties: false });
export type Receipt = Static<typeof Receipt>;

export type Started = { runId: string; startedAt: number; token: string };
export type Progress = { tools: ToolRow[]; toolCount: number; failedCount: number; done: boolean };
/** This browser's run in this chat, running or finished and not yet taken. */
export type Active = { runId?: string; startedAt?: number; send?: boolean; progress?: Progress };
export type Result = {
	improved?: string;
	/** The chat did not let this helper run `exec`, so it worked with `read` and `ls` only. */
	readOnly?: boolean;
	error?: string;
	cancelled?: boolean;
};

export type Operations = {
	start: [Static<typeof StartInput>, Started];
	active: [Receipt, Active];
	cancel: [Receipt, { cancelled: boolean }];
	take: [Receipt, Result];
};
