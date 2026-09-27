# Safety and State Reliability Design

Date: 2026-09-27  
Target: `iceburning-coder/thinkcell-addin` at `24762f1`  
Status: Approved for implementation planning

## 1. Objective

Deliver the first two remediation phases as one programme with two release gates:

1. **Gate A — security and data protection:** untrusted chart state cannot execute script, render failures cannot reuse stale output, and failed updates cannot destroy the only chart copy.
2. **Gate B — durable state and Excel links:** inserted charts use stable IDs, legacy states migrate safely, and Excel refreshes are serialized and resilient to sheet/range changes.

Gate A may ship before Gate B. Gate B must not weaken Gate A.

## 2. Scope

### Included

- Clipboard, local draft, advanced JSON, document-settings and SVG trust boundaries.
- PowerPoint and Excel capability detection and graceful degradation.
- Transactional insert/update behaviour in both hosts.
- Versioned v3 state keyed by a stable `chartId`.
- Legacy v1/v2 and shape-name keyed state migration.
- Excel named-range links, event intersection, internal-write suppression and per-chart refresh queues.
- Known Python engine edge cases: zero denominators, all-zero series, degenerate regressions and non-finite input.
- Automated JavaScript and Python regression tests plus an Office manual matrix.

### Excluded

- Web Worker migration and Pyodide bundle splitting.
- OneDrive/Graph cross-program links and Custom Functions.
- New chart types and wider think-cell feature parity.
- Broad visual redesign.

## 3. Constraints

- Keep the current framework-free UI and GitHub Pages deployment.
- Use conservative browser syntax and classic scripts for Office WKWebView compatibility.
- Do not make a bundler a production dependency.
- Preserve existing v1/v2 charts and clipboard payloads.
- Prefer duplicates or explicit recovery states over destructive cleanup.
- The currently shipped `tccore` source must become reviewable and testable in this repository before engine changes are made.

## 4. Module boundaries

The existing `taskpane.js` remains the UI coordinator and owns `GRID`, `TYPES`, option controls and `buildSpec()`. Four classic-script modules are added before it:

- `tc-state.js`
  - v1/v2/v3 migration and validation.
  - payload and complexity limits.
  - chart ID generation.
  - SVG DOM allow-list parsing.
  - structured `TCError` construction.
- `tc-office.js`
  - Office requirement-set capability matrix.
  - checked Promise wrappers for callback APIs.
  - low-level PowerPoint and Excel host operations.
- `tc-store.js`
  - settings keys, v3 index, revisions and pending records.
  - stable identity lookup and legacy name-key migration.
  - duplicate/orphan detection without automatic deletion.
- `tc-link.js`
  - Excel link records and defined names.
  - event-to-range matching.
  - precise internal-write echo suppression.
  - per-chart debounce and serial refresh queues.

Each file exposes a testable `TC.*` API and conditionally exports the same API through CommonJS for Node tests. No ES module loader is required in production.

## 5. State model

The canonical v3 record is an envelope, separate from the current flat panel state:

```json
{
  "version": 3,
  "chartId": "4eb927f0-c3fa-4ab8-a828-6c809ad19857",
  "revision": 12,
  "chart": {
    "type": "column",
    "data": "Category\tRevenue\n2025\t10",
    "title": "Revenue",
    "subtitle": "USD million",
    "source": "",
    "theme": "consulting",
    "dec": "",
    "size": "680x400",
    "legend": "auto",
    "legendRev": false,
    "mag": "1",
    "opt": {},
    "ann": {},
    "colors": {},
    "json": null
  },
  "link": null,
  "meta": {
    "engineVersion": "1",
    "updatedAt": "2026-09-27T00:00:00.000Z"
  }
}
```

For an Excel-linked chart, `link` is:

```json
{
  "kind": "excel-range",
  "definedName": "_tc_4eb927f0c3fa4ab8a8286c809ad19857",
  "worksheetId": "{worksheet-id}",
  "lastAddress": "Sheet1!A1:D8",
  "status": "active"
}
```

Storage keys:

- `TC:chart:<chartId>` — authoritative document record.
- `TC:index:v3` — map from chart ID to host reference, revision and last-seen metadata.
- `TC:pending:<chartId>` — recoverable transaction marker.
- Existing `TC:index` and shape-name keys remain readable during migration.

`localStorage.tc.state` is only a draft. It may use a v3 envelope without a `chartId`; it never overrides an inserted document record.

## 6. Identity and migration

- PowerPoint shapes carry `TCCHART=1`, `TCCHART_ID=<uuid>` and `TCCHART_REV=<revision>` tags when the API supports tags. The name remains `TC:<chartId>` as a visible fallback.
- Excel shapes use `TC:<chartId>` as the canonical name and place a non-sensitive marker in alternative text. Full state is not placed in alternative text.
- Reading a v1/v2 or legacy shape-name record migrates it in memory. It is persisted as v3 only after a successful chart operation.
- Legacy keys are retained and marked in the index. They are deleted only through an explicit maintenance command.
- If a copied shape shares an ID with a still-existing original, first edit forks a new ID and copies the record. If the original no longer exists, the surviving shape adopts the ID.
- A record with `version > 3` is read-only. Older code must never overwrite it.

## 7. Validation and security

### Input validation

All ingress paths call the same normalizer:

- `TCCHART1` clipboard payload.
- `localStorage` draft.
- advanced JSON.
- document settings.
- Excel-linked cell data after it is converted to panel text.

Validation enforces:

- accepted chart types and finite numeric values;
- bounded rows, columns, strings, JSON depth and serialized bytes;
- valid hex colours and bounded theme arrays;
- valid dates and annotation indices;
- plain data only: no functions, prototypes, DOM nodes or URLs;
- future versions rejected for writes.

### SVG generation and display

- Python escapes all string-valued SVG attributes with quote escaping, not only text nodes.
- Paint values are validated before serialization.
- Browser preview parses output with `DOMParser`, allows only the engine's SVG elements and attributes, removes event attributes, and rejects external or script URLs.
- Preview content is installed using DOM nodes, never untrusted `innerHTML`.
- Sanitizer rejection invalidates the render result and disables insertion/update actions.

The browser sanitizer is defence in depth; correct Python escaping remains mandatory because exported SVG does not pass through the preview DOM.

## 8. Render lifecycle

Each render receives a monotonically increasing `renderId`:

```text
normalize input
  -> build spec
  -> render in Python
  -> validate and sanitize output
  -> confirm renderId is current
  -> publish immutable LAST snapshot
```

At render start and on any error, the previous `LAST` is invalidated. Buttons stay disabled until the current render succeeds. A late render can never overwrite a newer result.

Structured errors have a stable code, user-safe message, recovery flag and optional diagnostic details. Raw exceptions are available through a copyable diagnostic report rather than injected into the UI.

## 9. Capability policy

`tc-office.js` computes capabilities once Office is ready and exposes feature-level flags. Important gates include:

- Image coercion/SVG insertion support.
- `PowerPointApi 1.5` selection and shape inspection.
- `PowerPointApi 1.2` slide insertion.
- `ExcelApi 1.9` SVG shapes and collection-level change events.
- Per-worksheet events and PNG insertion fallbacks.

Unsupported actions are disabled with an explanation. Capability checks occur before destructive or persistent work; exceptions remain a secondary guard.

When PowerPoint cannot identify the inserted shape reliably, it may insert an untracked PNG/SVG, but it must not delete or update an existing chart. When Excel SVG insertion fails during `context.sync()`, the operation retries as PNG only after the failed batch is discarded.

## 10. Transactional replacement

Every update follows four states:

```text
prepared -> inserted -> persisted -> committed
```

1. **prepared:** load the old shape's immutable identity and geometry; create a pending operation ID.
2. **inserted:** add a new shape named `TC-PENDING:<chartId>:<operationId>` while retaining the old shape.
3. **persisted:** save the v3 record and pending metadata with a checked `saveAsync`.
4. **committed:** delete the old shape, rename/tag the new shape, update the index and clear pending metadata.

PowerPoint identifies the new shape from the selected shape when supported, otherwise from an unambiguous before/after ID delta. An ambiguous delta is recoverable and never triggers deletion.

Excel uses the returned shape proxy from `addSvg` or `addImage`. SVG failure at `sync()` is retried in a fresh `Excel.run` batch as PNG.

Failure rules:

- Before `persisted`: remove the pending new shape when possible; retain the old shape and old record.
- After `persisted` but before `committed`: retain both shapes and reconcile by revision on the next open/selection.
- Cleanup failure is reported as recoverable; it is never converted into data loss.
- Empty PowerPoint placeholders are also deleted only after successful insertion.

## 11. Excel link model

- Creating a link creates a workbook defined name `_tc_<uuid-without-hyphens>` that refers to the source range.
- The defined name is canonical because Excel adjusts it for row/column insertion and sheet rename. Worksheet ID and last address are diagnostic fallbacks.
- A missing name, `#REF!`, or deleted worksheet changes link status to `broken` while retaining the last successful chart and data.
- `onChanged` resolves the event worksheet by ID and uses Excel range intersection APIs. Address strings are not manually parsed for correctness decisions.
- Events enqueue affected chart IDs. Each chart has one debounce timer and one Promise tail, so replacements never overlap.
- An internal write registers an expected echo containing chart ID, worksheet ID, range and a value hash. The matching event is consumed once. A user edit with a different hash is processed even if it happens immediately.
- A failed refresh remains retryable but does not enter a tight loop.

## 12. Python engine hardening

The source currently exists only inside `py/pylib.zip` and is copied from a sibling directory by `build_pylib.py`. Before fixes, the shipped `tccore` package will be extracted into tracked `py/tccore/`; the build script will package that source. This makes security fixes reviewable and tests reproducible.

Required guards include:

- relative difference with a zero denominator;
- CAGR with non-positive start/end values or zero duration;
- Pareto with a zero total;
- bubble size with a zero/non-finite maximum or negative sizes;
- singular or underdetermined trend fitting;
- log transforms with non-positive values;
- non-finite geometry before SVG serialization.

Invalid calculations return stable, user-facing validation errors. They do not emit `NaN`/`Infinity` into SVG.

## 13. Recovery and maintenance

The task pane exposes non-destructive diagnostics when it detects:

- pending replacements;
- duplicate chart IDs;
- missing shapes with retained state;
- shapes without state;
- broken Excel links;
- legacy records eligible for cleanup.

Automatic reconciliation may finish an unambiguous pending rename or adopt a sole surviving shape. Deletion of settings, defined names or shapes always requires an explicit maintenance action.

## 14. Test strategy

### JavaScript

Use Node's built-in test runner with Office mocks:

- state migration, size/depth limits and future-version protection;
- malicious clipboard, JSON, SVG and colour payloads;
- render invalidation and stale-result suppression;
- capability matrix and callback failure propagation;
- fault injection at each transaction step;
- duplicate ID and orphan classification;
- Excel change intersection, expected-echo matching, debounce and serial ordering.

### Python

Use `unittest` against tracked `py/tccore`:

- every reproduced zero/degenerate case;
- non-finite inputs and log-domain failures;
- attribute/text escaping and safe SVG output;
- representative structural SVG snapshots.

### Office acceptance matrix

Manually verify current Windows and macOS PowerPoint/Excel plus at least one host lacking a preferred API. Cover insert, update, copy, rename, delete, reopen, cross-sheet links, structural range edits, broken links, rapid edits, settings-save failures and task-pane closure.

## 15. Release gates

### Gate A

- Security and engine tests pass.
- A failed replacement never removes the only old chart.
- Failed renders leave no actionable stale result.
- Unsupported Office APIs degrade visibly.
- Known Python crash fixtures produce stable validation errors.

### Gate B

- v1/v2 and legacy-name charts migrate and reopen successfully.
- Rename preserves identity; copy forks identity without overwriting the original.
- Excel rapid changes converge on the newest data without concurrent replacement.
- Sheet rename and row/column changes preserve links through defined names.
- Deleted ranges/sheets enter a stable broken-link state without loops.

## 16. Rollback

- Gate A and Gate B are separate commits/releases.
- Old v1/v2 records remain readable and are not bulk-deleted.
- v3 writes occur only after successful operations.
- Rolling back to the pre-v3 add-in leaves old records intact; it may not edit v3-only charts, but it cannot silently downgrade them.
- Cache-busting query parameters and manifest version are changed only after each gate passes its acceptance suite.
