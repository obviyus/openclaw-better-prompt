// From pi-better v0.2.0 (https://github.com/nicobailon/pi-better, MIT, Nico Bailon), unchanged.
// Left out: the Pi process launch and tool hook (OpenClaw's session fork gates tools) and replyProgress (a fork's reply never streams).

const OPEN = "<improved-prompt>";
const CLOSE = "</improved-prompt>";
// The opening tag counts only on a line of its own; the prompt itself may mention the tag inline.
const OPEN_LINE = `\n${OPEN}\n`;

const returnSection = (last: number, what: string) => `## Return

Give answers (1) to (${last}) in your reply, each starting a new line with its number, like "(1)". Then end it with the ${what}, complete, between these two lines and nothing after them:

${OPEN}
the ${what}
${CLOSE}`;

export function buildHelperTask(helper: string, prompt: string): string {
	return [
		helper.trim(),
		`## Prompt to deepen\n\n${prompt || "None given: deepen the task in progress in the conversation so far, including any feedback I gave on work already done."}`,
		returnSection(4, "rewritten prompt"),
	].join("\n\n");
}

export function parseMarkedPrompt(reply: string): string {
	const end = reply.lastIndexOf(CLOSE);
	const before = `\n${reply.slice(0, Math.max(end, 0))}`;
	const start = before.lastIndexOf(OPEN_LINE);
	if (end < 0 || start < 0) throw new Error(`The reply has no ${OPEN} … ${CLOSE} block.`);
	const prompt = before.slice(start + OPEN_LINE.length).trim();
	if (!prompt) throw new Error(`The reply's ${OPEN} block is empty.`);
	return prompt;
}
