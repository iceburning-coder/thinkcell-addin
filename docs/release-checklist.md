# Release checklist

## Formal release gate

1. Start from a reviewed baseline that already contains the current `staging/verify-staging.cjs`.
2. Run the complete JS and Python test suites in the implementation repository.
3. Commit the release candidate locally, then run `node staging/verify-staging.cjs --release <baseline>` from this repository. Release mode verifies that deployable files under `staging/` and `manifest-staging.xml` are unchanged from the baseline, that the entire staging working tree is clean, that `tc-elements.js` is not published at the formal root, and that the formal manifest GUID, `1.0.<release>.0` version, generator default, and both complete `https://iceburning-coder.github.io/thinkcell-addin/taskpane.html?v=<release>` URLs agree.
4. Review `git diff --stat <baseline>..HEAD` and `git diff --name-only <baseline>..HEAD` before publishing.
5. After publishing, verify the formal task pane, manifest, and newly referenced modules over HTTPS with a cache-busting query.

`staging/verify-staging.cjs` is release tooling rather than a deployable diagnostic asset, so its committed delta is excluded from the baseline comparison. The release mode still requires `git status --porcelain -- staging manifest-staging.xml` to be empty; an uncommitted verifier edit or any untracked staging file fails the gate. This permits a reviewed verifier hardening commit to precede a formal release while keeping the diagnostic runtime byte-stable.

## Known limitation in Day 3-B

PowerPoint copy handling is read-only during load and forks only at the first update. Excel has not yet adopted that timing: `xlPick` still calls `ensureUniqueIdentityForEdit` while a chart is being loaded (`taskpane.js:1698-1705`, through `repairReconciledShape` at `taskpane.js:1933-1938`). Selecting a copied Excel chart can therefore write its forked identity before the user saves an edit. Moving Excel identity repair to the update/save boundary is deferred; until then, do not describe Excel chart loading as read-only.

## Mac local upgrade to manifest v5

1. Quit PowerPoint and Excel completely.
2. In each application's `wef` directory, first move the existing `thinkcell-charts.manifest.xml` into a dated backup directory beside `wef`. Then copy the v5/v6 `manifest.xml` into `wef` with the exact target name `thinkcell-charts.manifest.xml`. Replace that one formal manifest; never add a second file carrying the same GUID `5c1f7b8e-3a2d-4c6e-9b0f-7d2e4a1c8b93`:
   - PowerPoint: `~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef/`
   - Excel: `~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/`
3. Reopen each application and confirm the formal button opens the expected `taskpane.html?v=<release>`. Keep the diagnostic manifest separate; it has its own GUID and `TcDiag.*` command IDs.

If Office reports that it cannot load the add-in, quit the affected application again. Under `~/Library/Containers/com.microsoft.<Application>/Data/Library/Application Support/Microsoft/Office/16.0/Wef/`, move the cached `{GUID}` subdirectory (including its `Manifests` cache), `AggregatedCache`, and `AppCommands` into a dated sibling directory such as `.../16.0/Wef_backup_YYYYMMDD/`. Move the affected application's Office web cache under its container `Data/Library/Caches/` into a separate dated backup when present; do not delete it. An obsolete development manifest that points to `https://localhost:*` may exist either in `Data/Documents/wef/` or in a cached `{GUID}/.../Manifests/` directory. Move it into the corresponding backup, preserving enough of its original path to restore it; never permanently delete it during diagnosis. Reopen Office and reload the formal manifest.

To roll back, quit the affected Office application, move the newly installed formal manifest and any regenerated cache entries into a separate rollback snapshot, then restore `thinkcell-charts.manifest.xml` and the cached `{GUID}`, `AggregatedCache`, `AppCommands`, and web-cache items from the dated backup to their original paths. Reopen Office and confirm the previous formal version loads before removing any backup manually.
