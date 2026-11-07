# Doc Review extraction spike

## Source and license

- Upstream: https://github.com/xMinor-1/bb-plugins
- Commit: `39cb158d98a5516903806f772bc53b02a8d722dd`
- Directory: `plugins/doc-review`
- License: MIT, Copyright (c) 2026 Foma; original notice retained in `LICENSES/doc-review-MIT.txt`.
- Candidate entry files were clean against that commit when inspected.

This records the source baseline for the implemented Markdown-only adaptation. `ui/text-ranges.ts` derives from the upstream utility, with strict unique quote matching and separately namespaced highlights. `ui/markdown-review.tsx` and `src/store.ts` adapt the interaction/persistence pattern to OpenSpec-specific contracts rather than copying the universal viewer/server.

## Check performed

Built `ui/markdown-doc.tsx`, `ui/comment-list.tsx`, `ui/comment-editor.tsx` and `src/store.ts` as independent entry points using Bun. React, public BB frontend SDK and Node built-ins were externalized. The existing upstream tsconfig resolved its vendored UI aliases. Generated files and module metadata are under the ignored project `.tmp/markdown-extraction/` directory.

Result: all four entry points bundled successfully (332 modules including upstream vendored UI). No `pdf-lib`, PDF renderer, LibreOffice, workbook engine or browser automation runtime appeared in the module graph. This is a dependency-boundary check, not a BB build or a live interaction test.

## Adaptation boundary

Reuse the Markdown text-range/highlight logic and selection-positioning pattern. The adapted view renders the whole document with BB Markdown; source-line block splitting is not needed because anchors use quotes and surrounding context. The comment list/editor and comment/reply persistence/handoff use the plugin's own contracts and namespace. Only BB scaffold UI controls are used, not the old upstream icon registry.

Remove drawing-preview branches from the comment list, PDF exchange/import methods from the store, non-Markdown anchors from types/contracts and their unused schema validation. The store currently imports `share.ts`, which pulls the universal contract; the adapted store must not keep that import merely to reuse a small type. Do not copy the 940-line universal review opener or 894-line universal server wholesale.

No shared library or changes to upstream are necessary at this boundary. This spike does not prove safe rendering, anchor relocation, state persistence, sending or full BB compatibility; those remain implementation and verification tasks.

## User decisions

- Archive OpenSpec through its normal workflow; do not link/move discussions to archive documents in v1.
- BB chat archive and OpenSpec archive are independent.
- Explicit document/change-to-thread links are many-to-many; visible selection is not an exclusive work assignment.
