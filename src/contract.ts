import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { Type } from "typebox";

const NoInput = Type.Object({}, { additionalProperties: false });
const RunId = Type.String({ minLength: 1, maxLength: 200 });
const Token = Type.String({ minLength: 16, maxLength: 200 });
const Tools = Type.Array(
	Type.Object({
		label: Type.String({ maxLength: 400 }),
		state: Type.Union([Type.Literal("running"), Type.Literal("ok"), Type.Literal("failed")]),
	}),
	{ maxItems: 12 },
);

export const contract = defineFeatureContract({
	pluginId: "better-prompt",
	operations: {
		start: {
			kind: "action",
			description: "Deepen the draft (or the task in progress) on a read-only copy of this chat.",
			input: Type.Object(
				{ prompt: Type.String({ maxLength: 100_000 }), send: Type.Optional(Type.Boolean()) },
				{ additionalProperties: false },
			),
			// `token` lets the browser that started the run take its result after a reload.
			output: Type.Object({ runId: RunId, startedAt: Type.Integer(), token: Token }),
		},
		active: {
			kind: "action",
			description: "This chat's /better run, running or finished and not yet taken, so a returning composer can show it.",
			input: NoInput,
			output: Type.Object({
				runId: Type.Optional(RunId),
				startedAt: Type.Optional(Type.Integer()),
				send: Type.Optional(Type.Boolean()),
				progress: Type.Optional(
					Type.Object({
						tools: Tools,
						toolCount: Type.Integer({ minimum: 0 }),
						failedCount: Type.Integer({ minimum: 0 }),
						done: Type.Boolean(),
					}),
				),
			}),
		},
		cancel: {
			kind: "action",
			description: "Stop this chat's /better run.",
			input: NoInput,
			output: Type.Object({ cancelled: Type.Boolean() }),
		},
		take: {
			kind: "action",
			description: "Take a finished /better result once, with the token its start returned.",
			input: Type.Object({ runId: RunId, token: Token }, { additionalProperties: false }),
			output: Type.Object({
				improved: Type.Optional(Type.String()),
				error: Type.Optional(Type.String()),
				cancelled: Type.Optional(Type.Boolean()),
			}),
		},
	},
	events: {
		// Labels and counts only: every operator connection receives plugin events, so the
		// conversation-derived prompt itself never travels here.
		progress: Type.Object({
			sessionKey: Type.String({ maxLength: 512 }),
			runId: RunId,
			startedAt: Type.Integer(),
			tools: Tools,
			toolCount: Type.Integer({ minimum: 0 }),
			failedCount: Type.Integer({ minimum: 0 }),
			done: Type.Boolean(),
		}),
	},
});
