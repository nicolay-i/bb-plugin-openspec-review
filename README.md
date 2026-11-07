# OpenSpec Review for BB

Browse the OpenSpec specifications, active changes and archive of a chat's checkout, and review their Markdown with quoted comments that you send to the agent. English and Russian UI.

## Install

```sh
bb plugin install "git:https://github.com/nicolay-i/bb-plugin-openspec-review.git@^0.1.0" --yes
```

Requirements:

- BB >=0.47 with Plugin SDK >=0.6.79.
- OpenSpec CLI **1.9.x** on PATH on the environment host. Other versions fail with an explicit error. On Windows use the global npm install (`npm install -g @fission-ai/openspec@1.9`); the host runs its JS entrypoint with Node, without a shell.
- A repo-local `openspec/` folder in the environment checkout. OpenSpec stores and global default stores are not supported.

## Use

- **Chat header → OpenSpec** opens the latest active change in a tab. The menu next to it picks another active change.
- The tab lists specifications, active changes and the archive. A change card shows artifacts, task progress, affected specs and chats that mention the change.
- Markdown links into `openspec/` can open in the **OpenSpec review** file opener.
- Select text and choose **Comment on selection**, or comment on the whole document. Comments are drafts until you choose **Send to chat**. Delivery queues behind active work; an unconfirmed delivery is not retried automatically.
- The UI language is under **Installed plugins → OpenSpec Review → Interface language** (`en` or `ru`). Documents are not translated.

The plugin is a viewer and review surface. It does not run Propose, Apply or Archive and does not edit documents.

## Agent command

The bundled `openspec-document-review` skill explains the handoff. After applying a comment, the agent closes it from the receiving thread:

```sh
bb openspec-review review resolve <comment-id>
```

Only comments sent to the invoking thread can be closed.

## Data and limits

- Comments live in plugin-owned SQLite storage in your BB, keyed by checkout and host. They are not committed to the repository. Removing the plugin can delete them; disable and reload keep them.
- A missing source document keeps its comments. Comments do not move to archived copies.
- Documents up to 4 MiB; planning tree up to 5,000 entries and 40 levels; CLI calls time out after 20 seconds.

## Development

```sh
npm ci
bun run typecheck
bun run test        # needs OpenSpec 1.9.x on PATH
bb plugin build
bb plugin install . --yes
```

SQLite tests are bundled with Bun and run under Node, the BB server runtime. Temporary files live under the ignored `.tmp/`. `tests/browser-matrix.ts` is an optional Playwright check against a running BB web UI (`QA_ORIGIN`, `QA_THREAD_PATH`).

## License

MIT, see [LICENSE](LICENSE).

Markdown text-range and highlight utilities and the comment interaction patterns are adapted from [Doc Review](https://github.com/xMinor-1/bb-plugins/tree/main/plugins/doc-review), upstream commit `39cb158d98a5516903806f772bc53b02a8d722dd`, MIT, Copyright (c) 2026 Foma. See the [adaptation notes](docs/doc-review-extraction.md) and the preserved [original notice](LICENSES/doc-review-MIT.txt). Vendored BB UI components come from BB's plugin scaffold.
