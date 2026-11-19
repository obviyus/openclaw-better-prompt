# Better Prompt

`/better` from [pi-better](https://github.com/nicobailon/pi-better) for OpenClaw's Control UI.

Type a rough request in a chat's composer and press the **Better** button (the pencil with
sparkles, next to **+**; it waits until you have typed something). A helper reads your code,
files and logs on a read-only copy of the chat while a card above the composer shows its tools.
Then the deeper version of your request replaces your draft; **Undo** (or ⌘Z) brings your draft
back. Nothing is sent until you press Enter.

- **It reuses the chat's prompt cache.** The helper is a fork of the chat: it sends the chat's
  own system prompt, tool list, model and thinking level, then its task, so the provider serves
  the chat's cached history.
- **It can only read.** It runs `read`, `ls` and `exec` (for searches); every other tool call is
  refused. `exec` runs only on chats you own, and never asks for approval: a command your exec
  approvals would ask about is denied. Like pi-better, a shell command could still write a file;
  only the helper's instructions tell it not to.
- **It works while the agent is busy**, on the chat as of the moment you pressed Better.
- **One at a time per chat.** Press **Cancel** on the card, or the Better button again, to stop
  it. Leaving the chat also stops it. It stops by itself after 20 minutes.

The helper's task is pi-better's [helper.md](./helper.md), unchanged.

## Install

```bash
openclaw plugins install @obviyus/better-prompt
```

The install shows the plugin's capabilities, including **conversation access** (the helper
reads a copy of your chat). Approve it once and **Better** appears in the composer; no config
edits or restart. To turn conversation access off later, set
`plugins.entries.better-prompt.hooks.allowConversationAccess` to `false`.

## Requirements

- OpenClaw with plugin forks that may run `read`, `ls` and `exec`, capability-approved
  conversation access, and composer tasks.
- The chat's tool policy must allow `read`, `ls` and `exec`.

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
