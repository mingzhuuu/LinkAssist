# Contributing

Use Node.js 24 and the Rust version documented in [development](docs/DEVELOPMENT.md). Install the native Tauri prerequisites for your platform.

```sh
git clone --recurse-submodules https://github.com/mingzhuuu/LinkAssist.git
cd LinkAssist
npm ci
npm run tauri dev
```

The data submodules are references for updating BLE numbers; ordinary application builds consume the generated TypeScript table. The pinned btleplug fork is fetched by Cargo.

Before submitting:

```sh
npm run docs:generate
npm run check
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
```

For transport/Core changes, build the desktop binary and run `npm run test:integration`. Follow [AGENTS.md](AGENTS.md), keep Lua extensions protocol-neutral, and add regression coverage for behavior changes. Do not change upstream submodules or lockfiles unrelated to your change.

PRs should explain the user-visible problem, solution, tests and remaining hardware/platform limitations. Keep unrelated cleanup separate. Contributions are made under the project's [MIT license](LICENSE); retain third-party notices. Use the issue forms for bugs/features and [SECURITY.md](SECURITY.md) for vulnerabilities.
