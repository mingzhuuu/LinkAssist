# Security policy

Security fixes target the current development branch and latest published preview. Older previews are not supported independently.

Use the repository's **Security → Report a vulnerability** option when enabled. If private reporting is unavailable, open an issue requesting a private contact channel without disclosing exploit details or sensitive data. Never attach your Core discovery file, tokens, private configuration, complete device recordings or signing keys to a public issue.

Include the affected version/platform, reproduction, impact and any suggested fix. No response SLA is currently promised.

## Trust boundaries

- The Core HTTP service binds to loopback and requires a bearer token. Other processes running as the same user are within the local trust boundary. Do not proxy it to a network interface or share its discovery token.
- Only load Lua and external pytest projects you trust. Lua has instruction/memory limits; selected Python projects intentionally execute external code with your account's access.
- Numeric canvas formulas accept a bounded mathematical grammar, not JavaScript. Invalid formulas return the unmodified input and are identified by the editor/import validation.
- Importing a layout disables script auto-run and lifecycle hooks until reviewed. Device writes and script actions can affect connected hardware.
- npm and RustSec audits run in CI. Development dependencies and platform-specific native dependencies are evaluated separately. See the current release notes for unresolved upstream advisories.
- Installation packages are unsigned unless a release explicitly states otherwise. Verify the published SHA-256 manifest and download only from this repository's Releases.

Before changing repository visibility, review **all reachable history** and enable GitHub secret scanning/push protection and private vulnerability reporting where available. Removing files from a later commit does not erase their earlier contents.
