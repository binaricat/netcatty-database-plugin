# DBX row-review layout audit

Reference: `t8y2/dbx` commit `b6c3d4780448c6f42c9a6aef2f187937d0660369`.
This is a source audit, not a claim that the DBX deletion dialog was run here.

## Evidence

- `apps/desktop/src/components/grid/DataGrid.vue` lines 17854–17866 connects row deletion to
  `DangerConfirmDialog`. `apps/desktop/src/components/editor/DangerConfirmDialog.vue` lines 134–183
  uses a compact 480 px dialog, one explanatory sentence, a scrolling detail
  block (160 px maximum), and one cancel/destructive footer.
- `DataGrid.vue` lines 6496–6504 and `apps/desktop/src/lib/dataGrid/dataGridDetail.ts`
  lines 295–300 construct table context plus complete JSON row details.
- DBX row deletion marks pending changes in `useDataGridEditor` lines
  1731–1774 / 1792–1810. It does **not** immediately execute the DELETE.
- `DataGrid.vue` lines 16953–17010 uses typed inline cell editors; the SQL
  preview is a separate bottom dock (default 208 px, minimum 120 px).
  `SqlPreviewPanel.vue` lines 195–258 uses a compact toolbar, wrapping,
  scrolling and syntax highlighting.

## Adaptation and deliberate differences

The plugin replaces its two-column delete review with a compact single-column
surface: title/table, consequence sentence, complete original-row JSON,
highlighted parameterized SQL, complete parameter values and one action footer.
It borrows DBX's information hierarchy, not its pending-change semantics:
confirmation here executes exactly one reviewed row mutation immediately.
This consequence stays explicit, and original-row conflict checks remain intact.

Netcatty main has no public API to open a contributed native modal from a view.
The review remains inline rather than calling private events or altering host
main. SQL is rendered as React text tokens, never HTML. These boundaries matter
more than cosmetically copying a dialog.

Automated component/controller and remote-DOM tests are separate from actual
application validation. Native alpha.20 validation now confirms the compact highlighted layout,
explicit one-row delete and subsequent SELECT readback on unchanged main.
The earlier port-closure investigation remains open; one recovered session is
not a root-cause fix. Screenshots of the preceding two-column alpha.18 layout
do not qualify this revision.
