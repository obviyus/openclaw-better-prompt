# Better Prompt

> Community plugin, not an official `@openclaw/*` package. Published to ClawHub under the
> `obviyus` owner scope.

`/better` from [pi-better](https://github.com/nicobailon/pi-better) for OpenClaw's Control UI.

Type a rough request in a chat's composer and press the **Better** button (the pencil with
sparkles, next to **+**; it waits until you have typed something). A helper reads your code,
files and logs on a read-only copy of the chat while a card above the composer shows its tools.
Then the deeper version of your request replaces your draft; **Undo** (or ⌘Z) brings your draft
back. Nothing is sent until you press Enter. **Better and send** (the lightning bolt beside it)
does the same and then sends the new prompt, as Enter would.

- **It reuses the chat's prompt cache.** The helper is a fork of the chat: it sends the chat's
  own system prompt, tool list, model and thinking level, then its task, so the provider serves
  the chat's cached history.
- **It can only read.** It asks for `read`, `ls` and `exec` (for searches); every other tool
  call is refused. OpenClaw admits `exec` only when the chat's latest turn is yours and you own
  the Gateway, and never asks for approval: a command your exec approvals would ask about is
  denied. Anyone else, or a chat whose tool policy refuses `exec`, gets a read-only helper with
  `read` and `ls`, and the card says the rewrite ran read-only. Like pi-better, a shell command
  could still write a file; only the helper's instructions tell it not to.
- **It works for everyone who can write in the chat**, including team members with only
  their own chats' write access. Its progress and result are private: only the browser that
  started a run, signed in as the same person, sees its tools, cancels it or takes its result.
- **It works while the agent is busy**, on the chat as of the moment you pressed Better.
- **One at a time per chat.** Press **Cancel** on the card, or the Better button again, to stop
  it. It keeps running when you switch chats or pages: come back and the card shows it again,
  and a result that finished meanwhile goes in then. It stops by itself after 20 minutes.

The helper's task is pi-better's [helper.md](./helper.md), unchanged.

## Install

```bash
openclaw plugins install clawhub:@obviyus/better-prompt
```

The install shows the plugin's capabilities, including **conversation access** (the helper
reads a copy of your chat). Approve it once and **Better** appears in the composer; no config
edits or restart. To turn conversation access off later, set
`plugins.entries.better-prompt.hooks.allowConversationAccess` to `false`.

## Requirements

- OpenClaw 2026.11.11 or later. Better needs
  [openclaw/openclaw#204411](https://github.com/openclaw/openclaw/pull/204411) (merged as
  `56f8670`), which runs a plugin's helper in the caller's own chat; the 2026.11.10 release line
  was cut before it. Conversation access must be approved.
- The chat's tool policy must allow `read` and `ls`; `exec` is optional.

## Develop

```bash
npm install --legacy-peer-deps
npm test                                    # pi-better's prompt tests and the progress rows
OPENCLAW_SOURCE=/path/to/openclaw npm run test:runtime   # run lifecycle against the SDK
npm run build                               # backend bundle, Control UI assets, metadata
```

## License

MIT. `helper.md` and the prompt functions in `src/better.ts` come from pi-better (MIT, Nico Bailon);
see `LICENSE.pi-better`.
