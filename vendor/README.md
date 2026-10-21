# GTK 3 compatibility backports

Tauri 2's Linux GTK 3 dependencies require the gtk-rs 0.18 API. These three
crates are checked-in, narrowly patched copies, not newer upstream releases.
Do not bump their version strings to make an advisory disappear.

| Crate | Original release | Local changes |
|---|---|---|
| `glib` | 0.18.5 | Backport the mutable FFI out-pointer fix for RUSTSEC-2024-0429; add optimized string-iterator regression tests; use maintained trybuild for file-based compile tests |
| `glib-macros` | 0.18.5 | Replace proc-macro-error with the existing syn error API; preserve compiler diagnostics and combined capture locations; validate enum payload modes before generating code; run upstream inline clone cases with Cargo directly |
| `gtk3-macros` | 0.18.2 | Use syn diagnostics; remove unused parser fields and the redundant member resolver setting |

Sources are the crates.io archives with the SHA256 values in `backports.json`.
Their archive hashes were verified against the application's original Cargo.lock.
Upstream `LICENSE`, `COPYRIGHT` (where supplied), `.cargo_vcs_info.json`, and
`Cargo.toml.orig` are retained. `Cargo.toml.orig` records the unmodified upstream
manifest; builds use the patched `Cargo.toml`. Cargo's cache marker `.cargo-ok`
is excluded. Reviewable differences are in `patches/`; original and resulting
file hashes are recorded in `backports.json` (null means a newly added file).

The GLib change is the two-line fix in
[gtk-rs/gtk-rs-core PR 1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343).
[RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html)
documents the old macro dependency's maintenance status. Its fork is also
unmaintained ([RUSTSEC-2026-0173](https://rustsec.org/advisories/RUSTSEC-2026-0173.html)),
so neither proc-macro-error nor proc-macro-error2 is used by these patches.

The standalone test workspace also exposed `basic-toml` via upstream `trybuild2`
(RUSTSEC-2026-0374). File-based tests now use `trybuild`; inline clone cases use
an isolated Cargo project and match expected diagnostic messages rather than
compiler-version-specific caret/source rendering. All upstream case inputs remain.

## Verification and ongoing auditing

- `npm run check:rust-backports`: verify every vendored file, both patch tables
  and both lockfiles. `.gitattributes` preserves hashed bytes across checkouts.
- `cargo check --manifest-path vendor/Cargo.toml --locked -p glib-macros -p gtk3-macros --lib`:
  compile both proc-macro implementations on Windows or Linux.
- `npm run test:rust-macros`: compile 28 valid/invalid macro inputs without GTK
  system libraries; assert expected diagnostics and absence of macro panics.
  Requires the dependencies fetched by the preceding Cargo command; uses offline resolution.
- On Linux, manually install GTK development libraries and run GLib library tests, the
  iterator regression and upstream GLib macro integration tests in **release**
  mode, then compile GTK and a valid CompositeTemplate subclass with these macros.
- `npm run audit:rust`: requires cargo-audit 0.22.2. Audits both the application
  and validation workspace. Because cargo-audit skips local path packages, it
  additionally audits temporary lockfiles carrying their original crates.io
  identities. It accepts only RUSTSEC-2024-0429 on glib 0.18.5 after successful
  file/patch verification. All other warnings and vulnerabilities fail the check.
  No global audit ignores are configured; raw evidence is retained in `logs/`.
  `CARGO_AUDIT` optionally specifies the cargo-audit executable path.

This is a maintained local backport, not a claim that GTK 3 is maintained upstream.
Recheck all three upstream package identities on every security audit. For any
edit, review the source diff and provenance before updating the manifest hashes;
never automatically bless a failed integrity check. Remove these patches and
their validation workspace when Tauri's dependency graph uses compatible,
maintained upstream releases that contain the GLib fix and no abandoned macro
diagnostic library. Regenerate locks and run the platform tests before removal.

The Windows release dependency graph does not include these GTK crates. Linux
runtime tests still require a Linux host; a Windows-only pass is not sufficient
evidence for a Linux release.
