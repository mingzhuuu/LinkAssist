# Third-party notices

LinkAssist's own code is licensed under MIT. Dependencies and data retain their own licenses; the project license does not replace those terms.

| Component | Source | License |
|---|---|---|
| BLE assigned-number data | [Nordic Semiconductor](https://github.com/nordicsemi/bluetooth-numbers-database) | BSD-3-Clause; preserve Nordic's copyright and disclaimer |
| Web Bluetooth registries | [WebBluetoothCG](https://github.com/WebBluetoothCG/registries) | Apache-2.0 |
| Bluetooth backend fork | [mingzhuliv/btleplug](https://github.com/mingzhuliv/btleplug/tree/65c0d76b6f4e5e51d9012723d5ff01fd412e7186) | See exact locked crate's license texts |
| Frontend and native dependencies | `package-lock.json`, `src-tauri/Cargo.lock` | Per-package terms in the generated inventory |

`third-party-licenses/inventory.json` records the selected Windows dependency graph and npm production dependencies. `third-party-licenses/THIRD_PARTY_LICENSES.txt` preserves license and NOTICE files shipped with those packages and the referenced datasets. It includes build dependencies; inclusion does not claim every listed crate is linked into the final executable.

Regenerate after lockfile changes, with Node/Rust dependencies available and data submodules initialized:

```sh
npm run licenses:generate
```

Review entries without bundled license texts against the upstream source before distributing binaries. Generated SPDX identifiers are inventory information, not an automated determination that every combination is compatible. Other target platforms require their own dependency inventory via `LINKASSIST_LICENSE_TARGET`.

Supplemental texts for crates that omit them are stored in `third-party-licenses/upstream/`; `sources.json` records the exact upstream commits and license URLs. The unmodified MPL-2.0 `selectors` source is available at the source link recorded there, and in the versioned crate at `https://crates.io/crates/selectors/0.38.0`. The generator fails if any dependency still lacks a collected text.

Distributions must include this notice, the license-text collection, and the project's LICENSE. The release workflow includes these materials with the installer.
