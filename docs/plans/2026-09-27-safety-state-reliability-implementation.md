# Safety and State Reliability Implementation Plan

> Execute this plan task by task with red/green tests and small commits. Do not combine Gate A and Gate B into one unreviewable patch.

**Goal:** Eliminate code-execution and chart-loss paths, then move inserted charts and Excel links to a recoverable v3 identity model.

**Architecture:** Keep `taskpane.js` as the UI/chart-spec coordinator. Add four classic-script modules for state/security, Office adapters, document storage and Excel link scheduling. Vendor the shipped Python engine source, harden it, and rebuild `py/pylib.zip` from tracked inputs.

**Technology:** Plain JavaScript, Node built-in test runner, Office.js mocks, Python 3 `unittest`, Pyodide 0.27.2, GitHub Pages.

---

## Gate A — Security and data protection

### Task 1: Make the shipped engine source reviewable

**Files:**

- Create: `py/tccore/*.py` from the `tccore/` package currently shipped in `py/pylib.zip`
- Create: `requirements-build.txt`
- Modify: `build_pylib.py:5-19`
- Create: `tests/python/test_engine_smoke.py`

**Steps:**

1. Add a failing smoke test that prepends `py/` to `sys.path`, imports `tccore.report.build_figure`, renders a minimal column chart and asserts the SVG starts with `<svg`.
2. Run `python3 -m unittest discover -s tests/python -p 'test_engine_smoke.py' -v`; expect an import failure because `py/tccore` is not tracked yet.
3. Extract only the shipped `tccore/` package into `py/tccore/` and add it to version control.
4. Change `build_pylib.py` to package `here / "py" / "tccore"` instead of `here.parent / "scripts" / "tccore"`.
5. Pin the build-time packages currently shipped: `python-pptx==1.0.2` and `XlsxWriter==3.2.9`.
6. Run the same discovery command again; expect one passing test.
7. Run `python3 build_pylib.py`, unpack the result into a temporary directory and run `python3 -c` with that directory on `sys.path` to import `addin_api`.
8. Commit: `build: vendor the shipped chart engine source`.

### Task 2: Add the JavaScript test seam

**Files:**

- Create: `package.json`
- Create: `tests/js/helpers/load-script.cjs`
- Create: `tests/js/state.test.cjs`
- Create: `tc-state.js`
- Modify: `taskpane.html:136-137`

**Steps:**

1. Configure `npm test` to run `node --test tests/js/*.test.cjs` followed by Python `unittest` discovery.
2. Add a test that loads `tc-state.js` without a browser and expects `TC.State.CURRENT_VERSION === 3`.
3. Run `node --test tests/js/state.test.cjs`; expect a missing-file failure.
4. Add the minimal classic-script/CommonJS wrapper and constant.
5. Include `tc-state.js` before `taskpane.js` in `taskpane.html`.
6. Run the JavaScript test; expect it to pass.
7. Commit: `test: add browser-compatible state module harness`.

### Task 3: Validate and migrate all incoming state

**Files:**

- Modify: `tc-state.js`
- Modify: `taskpane.js:17-18,151-174,1185-1205`
- Create: `tests/js/state-migration.test.cjs`
- Create: `tests/js/state-security.test.cjs`

**Steps:**

1. Write table-driven failing tests for valid v2 migration, v3 round trip, future-version read-only handling, invalid chart type, non-finite numbers, invalid colours, oversized clipboard input, excessive JSON depth and prototype-pollution keys.
2. Run the two tests; expect the new cases to fail.
3. Implement `TC.State.normalize`, `migrate`, `validateChart`, `validateSpec`, `serializeClipboard`, `parseClipboard`, `createChartId` and `TCError`.
4. Use `crypto.randomUUID()` when available and a `crypto.getRandomValues()` UUID fallback otherwise.
5. Replace direct `JSON.parse` in `pasteChart`, advanced JSON, `loadState` and document-state application with the shared normalizer.
6. Replace deprecated `escape/unescape` clipboard encoding with UTF-8 `TextEncoder`/`TextDecoder` helpers plus a compatible fallback.
7. Ensure rejected input does not mutate the panel, `EDIT`, `SEL_ADDRESS` or saved draft.
8. Run `node --test tests/js/state-migration.test.cjs tests/js/state-security.test.cjs`; expect all cases to pass.
9. Commit: `security: validate and version every chart-state ingress`.

### Task 4: Harden Python SVG output and engine edge cases

**Files:**

- Modify: `py/tccore/canvas.py:160-197,370-389`
- Modify: `py/tccore/annotations.py:33-139`
- Modify: `py/tccore/charts_line.py:301-322`
- Modify: `py/tccore/charts_xy.py:30-74,77-106`
- Modify: `py/tccore/report.py:62-108`
- Modify: `py/addin_api.py:9-20`
- Create: `tests/python/test_svg_security.py`
- Create: `tests/python/test_engine_edge_cases.py`

**Steps:**

1. Add failing tests for quote-bearing colours/fonts, event-attribute payloads, zero relative differences, zero/non-positive CAGR bases, zero-duration CAGR, all-zero Pareto, all-zero/negative bubble sizes, one-point trends, repeated-X trends and log-domain violations.
2. Assert that no successful SVG contains `onload=`, `onerror=`, `javascript:`, `NaN` or `Infinity`.
3. Run `python3 -m unittest discover -s tests/python -p 'test_*.py' -v`; confirm the reproduced failures.
4. Escape all SVG attributes with `html.escape(..., quote=True)` and validate paint, dash, font and numeric geometry values before serialization.
5. Add explicit domain guards to annotations, Pareto, bubble radius calculation and `_fit`; raise stable `ValueError` messages for undefined calculations.
6. Validate chart kind and finite geometry at the report/add-in boundary.
7. Return structured error code/message data from `addin_api` without exposing a Python traceback to the UI.
8. Run the new tests and the smoke test; expect all to pass.
9. Rebuild `py/pylib.zip` and repeat the tests against the unpacked archive.
10. Commit: `security: harden SVG serialization and numeric edge cases`.

### Task 5: Sanitize preview SVG and invalidate stale renders

**Files:**

- Modify: `tc-state.js`
- Modify: `taskpane.js:725-751`
- Create: `tests/js/svg-sanitizer.test.cjs`
- Create: `tests/js/render-lifecycle.test.cjs`

**Steps:**

1. Add failing sanitizer tests for scripts, `foreignObject`, event attributes, external `href`, `javascript:` URLs, unknown tags and valid engine primitives.
2. Add a render-controller test where render 1 completes after render 2 and where a failed render follows a successful render; assert only render 2 can publish `LAST` and failure leaves `LAST === null`.
3. Implement the SVG allow-list parser in `TC.State.sanitizeSvg` and install sanitized DOM nodes with `replaceChildren`.
4. Add `RENDER_SEQ`; invalidate `LAST`, preview metadata and action buttons at render start and on every error.
5. Publish a frozen snapshot only after spec validation, engine success and SVG sanitization.
6. Run the two JavaScript test files; expect all tests to pass.
7. Manually paste the previously reproduced malicious colour payload and confirm the preview reports an invalid chart without executing code.
8. Commit: `security: sanitize SVG previews and reject stale renders`.

### Task 6: Centralize Office capabilities and checked async calls

**Files:**

- Create: `tc-office.js`
- Modify: `taskpane.html:136-137`
- Modify: `taskpane.js:790-879,1207-1281`
- Create: `tests/js/office-capabilities.test.cjs`
- Create: `tests/js/office-async.test.cjs`

**Steps:**

1. Add failing tests for PowerPoint 1.2/1.5 and Excel 1.9 capability combinations, missing `Office.context.requirements`, callback failure, thrown error and rejected `context.sync()`.
2. Implement `TC.Office.getCapabilities`, `fromAsyncResult`, `saveSettings`, `runPowerPoint` and `runExcel`.
3. Load the module before `taskpane.js`.
4. Replace direct callback wrappers and best-effort catches with checked helpers.
5. Gate shape selection/update, slide insertion, Excel SVG insertion and worksheet events before use.
6. Show disabled-action reasons in the task pane; retain PNG insertion where supported.
7. Run both Office adapter tests; expect all cases to pass.
8. Commit: `fix: gate Office features and propagate async failures`.

### Task 7: Implement transactional PowerPoint replacement

**Files:**

- Modify: `tc-office.js`
- Modify: `taskpane.js:811-864,924-942`
- Create: `tests/js/powerpoint-transaction.test.cjs`

**Steps:**

1. Build a fake PowerPoint adapter and add a failing fault-injection test for each boundary: snapshot, insert, identify, persist, delete and rename/tag.
2. Assert the old shape exists for every failure before persistence, and that failures after persistence produce a recoverable duplicate instead of no chart.
3. Implement `preparePptReplacement`, `insertPendingPptShape`, `commitPptReplacement` and best-effort pending cleanup.
4. Resolve the inserted shape from `getSelectedShapes()` on PowerPoint 1.5; otherwise accept only a single before/after ID delta.
5. Move empty-placeholder deletion to the commit step.
6. Refactor `pptInsertSvg` and `pptUpdate` to use the transaction; no code path may call `old.delete()` before successful insertion and state persistence.
7. Run the transaction tests; expect all fault points to pass.
8. Commit: `fix: make PowerPoint chart replacement non-destructive`.

### Task 8: Implement transactional Excel replacement and theme fallback

**Files:**

- Modify: `tc-office.js`
- Modify: `taskpane.js:946-987,1109-1172`
- Create: `tests/js/excel-transaction.test.cjs`
- Create: `tests/js/native-theme.test.cjs`

**Steps:**

1. Add failing tests for SVG failure during `context.sync()`, PNG fallback in a fresh batch, state-save failure, old-shape deletion failure and custom-theme native chart colours.
2. Implement separate insert attempts for SVG and PNG; do not catch only the synchronous `addSvg()` call.
3. Insert and sync the pending new shape before persisting state or deleting the old shape.
4. Commit the replacement only after checked settings persistence.
5. Add `resolvePalette(theme)` that accepts built-in names and custom theme objects.
6. Refactor `xlInsertSvg`, `xlReplaceShape`, `xlUpdate` and native chart styling to use these helpers.
7. Run both tests; expect all cases to pass.
8. Commit: `fix: make Excel replacement transactional and theme-safe`.

### Task 9: Gate A verification and release checkpoint

**Files:**

- Modify: `README.md`
- Modify only after verification: `manifest.xml`, `make_manifest.py`, `taskpane.html`

**Steps:**

1. Run `npm test`; expect zero failures.
2. Serve the repository locally and verify browser preview for every chart sample plus malicious payload fixtures.
3. Run the Gate A Office matrix on available macOS PowerPoint and Excel hosts.
4. Verify a forced insert failure leaves the old chart or placeholder intact.
5. Document capability fallbacks and the diagnostic/error behaviour in `README.md`.
6. Only after acceptance, bump the add-in version and asset query string together.
7. Commit: `release: establish the add-in safety baseline`.

---

## Gate B — Stable state and Excel link reliability

### Task 10: Add the v3 document store

**Files:**

- Create: `tc-store.js`
- Modify: `taskpane.html`
- Modify: `taskpane.js:795-805,882-923,1185-1205`
- Create: `tests/js/store.test.cjs`
- Create: `tests/js/store-migration.test.cjs`

**Steps:**

1. Add failing tests for checked settings saves, v3 keys/index, in-memory v2 migration, successful-write migration, failed-write preservation, future-version protection and missing settings support.
2. Implement `TC.Store` with `load`, `save`, `beginPending`, `commitPending`, `clearPending`, `loadLegacy` and `classifyRecords`.
3. Store chart data under `TC:chart:<chartId>` and index metadata under `TC:index:v3`.
4. Keep `TC:index` and old name-keyed records untouched until explicit maintenance.
5. Refactor selection/load/save paths to pass envelopes rather than flat state.
6. Run both store tests; expect all cases to pass.
7. Commit: `feat: introduce versioned document chart storage`.

### Task 11: Move host identity from shape name to chart ID

**Files:**

- Modify: `tc-store.js`
- Modify: `tc-office.js`
- Modify: `taskpane.js:805-942,949-987,1087-1127`
- Create: `tests/js/identity-reconciliation.test.cjs`

**Steps:**

1. Add failing tests for shape rename, original-shape deletion, copied shape with duplicate ID, pending duplicate after a crash and an untracked `TC:` shape.
2. Implement PowerPoint tag and name resolution, with the name as fallback only.
3. Implement Excel name/alternative-text identity resolution.
4. Add reconciliation rules: adopt a sole survivor, fork a copied duplicate, prefer the highest committed revision and never auto-delete ambiguous records.
5. Change `EDIT` and `SEL_CHART` to carry `chartId`, revision and host shape reference separately.
6. Update insert/update transactions to increment revision and keep pending markers until commit.
7. Run the reconciliation tests; expect all cases to pass.
8. Commit: `feat: identify inserted charts with stable chart IDs`.

### Task 12: Add named-range Excel links

**Files:**

- Create: `tc-link.js`
- Modify: `taskpane.html`
- Modify: `taskpane.js:985-1047,1109-1127,1174-1183`
- Create: `tests/js/link-record.test.cjs`
- Create: `tests/js/link-resolution.test.cjs`

**Steps:**

1. Add failing tests for defined-name generation, cross-sheet selection, sheet names containing apostrophes, renamed sheets, moved ranges, deleted sheets and `#REF!` names.
2. Implement a stable defined-name generator using the UUID without hyphens.
3. On link creation, create the workbook defined name and record its name, worksheet ID and last address.
4. Resolve current ranges from the defined name; use stored address only for diagnostics.
5. Mark missing/deleted references as `broken` and retain the last successful image/data.
6. Fix native chart insertion to resolve the selected worksheet rather than stripping `!` and using the active worksheet.
7. Run both link tests; expect all cases to pass.
8. Commit: `feat: track Excel chart links with workbook names`.

### Task 13: Serialize Excel refreshes and suppress only exact echoes

**Files:**

- Modify: `tc-link.js`
- Modify: `taskpane.js:1026-1084`
- Create: `tests/js/link-queue.test.cjs`
- Create: `tests/js/link-events.test.cjs`

**Steps:**

1. Add failing fake-timer tests for rapid edits, overlapping refresh duration, edits arriving during refresh, two independent chart IDs and refresh failure followed by a new edit.
2. Add failing tests proving an internal write's matching range/value hash is consumed once while a different immediate user value is not suppressed.
3. Implement one debounce timer and one Promise tail per chart ID.
4. Replace `LINK_MUTE_UNTIL` with expected-echo records keyed by chart ID, worksheet ID, range and stable value hash. Expiry is cleanup only, never the matching rule.
5. Use Office range intersection for same-worksheet decisions and batch range resolution where possible.
6. Ensure the queue coalesces to the newest revision and never runs two replacements for one chart concurrently.
7. Run both queue/event tests; expect all cases to pass.
8. Commit: `fix: serialize Excel link refresh and match internal echoes`.

### Task 14: Add recovery diagnostics and explicit maintenance

**Files:**

- Modify: `tc-store.js`
- Modify: `taskpane.html:23-26,106-127`
- Modify: `taskpane.css`
- Modify: `taskpane.js:896-923,1087-1107,1215-1281`
- Create: `tests/js/maintenance.test.cjs`

**Steps:**

1. Add failing tests that classify pending operations, duplicate IDs, orphan records, untracked shapes, broken links and migrated legacy keys.
2. Add a compact document-status UI with non-destructive actions: retry pending commit, fork duplicate, relink range and inspect orphan.
3. Keep destructive cleanup behind a separate confirmation and operate on explicit IDs only.
4. Add a copyable diagnostic report containing versions, capability flags and error codes but no chart data by default.
5. Run the maintenance tests; expect all cases to pass.
6. Commit: `feat: surface recoverable document and link problems`.

### Task 15: Gate B migration and Office acceptance

**Files:**

- Create: `tests/fixtures/state-v1.json`
- Create: `tests/fixtures/state-v2.json`
- Create: `tests/fixtures/state-v3.json`
- Modify: `README.md`
- Modify only after verification: `manifest.xml`, `make_manifest.py`, `taskpane.html`

**Steps:**

1. Run `npm test`; expect zero failures.
2. Open fixtures representing v1, v2 and v3 and verify load, edit, save, close and reopen.
3. In PowerPoint verify update, rename, copy, delete, crash/pending recovery and fallback behaviour on a host without shape inspection.
4. In Excel verify cross-sheet links, rapid edits, panel-to-cell writeback, row/column insertion, sheet rename, sheet delete, relink and broken-link recovery.
5. Confirm no orphan or legacy record is deleted without an explicit maintenance action.
6. Update `README.md` with the v3 model, migration guarantees, link limitations and recovery workflow.
7. Only after acceptance, bump the add-in version and cache-busting query string.
8. Commit: `release: enable stable chart identity and resilient Excel links`.

## Final verification

Run:

```bash
npm test
python3 build_pylib.py
python3 -m unittest discover -s tests/python -p 'test_*.py' -v
```

Expected result: all JavaScript and Python tests pass, `py/pylib.zip` rebuilds successfully, and the generated archive imports `addin_api` under the supported Python/Pyodide version.

Then complete the manual Office matrix documented in the design. Do not claim Gate A or Gate B complete solely from browser/Node tests.
