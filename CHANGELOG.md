# Changelog

## Unreleased

- Backport the GLib string-iterator safety fix and remove abandoned proc-macro diagnostics; verify vendored sources and retain upstream advisory coverage in CI.

- Replace JavaScript formula execution with bounded numeric expressions and editor validation.
- Bound automation/lifecycle Lua loading by instruction and memory budgets; move parsing off async workers.
- Validate layout imports before changing stores, migrate legacy canvas data, and resolve relative resources beside the imported JSON.
- Prevent deleted/replaced canvases from receiving late parse results; display queue overload and failures.
- Avoid serializing terminal layout on every receive event; lazy-load heavy dialogs and charts.
- Preserve TCP server/UDP binding addresses for incoming channel routing and clear routes on stop.
- Write Core discovery tokens atomically with owner-only file permissions on Unix.
- Update frontend dependencies and migrate the maintained Tailwind compiler.
- Add MIT licensing, third-party notices, contributor/security guidance, CI and draft Windows releases.
- Remove local snapshots and developer artifacts from the current source tree while preserving prior Git history.

Compatibility: arbitrary JavaScript formulas are no longer supported. Use arithmetic, column variables and documented Math functions. Imported script auto-run/lifecycle hooks require explicit re-enabling. Tailwind 4 requires a recent WebView; Windows preview builds target Evergreen WebView2. Other platforms remain unverified until tested.
