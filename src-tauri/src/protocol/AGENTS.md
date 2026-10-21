# src-tauri/src/protocol — Parser Engine and Lua Protocol Files

## OVERVIEW

Protocol parser with passthrough, field-definition, inline Lua, and Lua protocol-file helpers. Frontend mirrors most IPC types in `src/types/protocol.ts` and parser UI lives in `src/components/parser/`.

## STRUCTURE

```
protocol/
├── mod.rs          # ProtocolManager: mode dispatch, templates, protocol-file helpers
├── types.rs        # FieldType, FieldDefinition, ParseResult, summaries, templates
├── parser.rs       # offset-based typed binary extraction
├── lua_engine.rs   # mlua runtime, sandbox, helpers, schema/parse contract
└── templates.rs    # built-in templates
```

## MODES / ENTRY POINTS

| Mode/API | Handler | Notes |
|----------|---------|-------|
| `Passthrough` | `ProtocolManager::passthrough_parse()` | Raw bytes rendered as hex |
| `FieldDefinition` | `FieldParser::parse()` | Offset + field type extraction with bounds checks |
| `LuaScript` | `LuaEngine::execute()` | Active inline script must define `parse(data, len)` |
| Protocol file summary | `get_lua_protocol_file_summary(PathBuf)` | Reads Lua file `schema()` metadata for UI |
| Parse with file | `parse_data_with_lua_file(PathBuf, &[u8])` | Used by parsed-mode canvases/charts/forms |

## TYPE SYSTEM

- `FieldType`: integer, float, bool, fixed byte array, fixed UTF-8 string variants.
- `FieldValue`: untagged integer/float/bool/string/bytes. Do not change serde shape without TS updates.
- `FieldDefinition` and `ParsedField` currently serialize snake_case fields (`field_type`, `raw_bytes`).
- Protocol-file summary structs serialize camelCase (`filePath`, `fieldType`, `displayFormat`).

## LUA SANDBOX

- Runtime: `mlua` with vendored Lua 5.4.
- Removed globals: `os`, `io`, `require`, `dofile`, `loadfile`.
- Lua files must start with type marker: `-- linkassist:type = protocol` (validated by `script_markers.rs`).
- Script contract: global `parse(data, len)` returns table with `fields`; optional `schema()` powers protocol-file summaries.
- `validate_script()` loads and dry-runs scripts; keep this cheap and deterministic.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add `FieldType` | `types.rs`, `parser.rs`, `src/types/protocol.ts` | Add size, extraction, formatting, TS union |
| Add display format | `types.rs`, `parser.rs`, TS type | Update `format_value()` |
| Add Lua helper | `lua_engine.rs` | Register helper without expanding sandbox globals |
| Add template | `templates.rs` | Keep IDs unique and update frontend expectations if surfaced |
| Change protocol-file schema | `lua_engine.rs`, `types.rs`, `src/types/protocol.ts`, examples | Update `config/protocol/protocol-configuration-guide.md` |

## TESTING

- Existing Rust tests are sparse/missing despite protocol being high-risk; add inline `#[cfg(test)]` modules for parser boundaries, Lua sandbox restrictions, templates, and protocol-file summary parsing.
- Run `cd src-tauri && cargo test` after parser/Lua changes.
- Run `npm run build` after changing mirrored TS types.

## ANTI-PATTERNS

- Do not re-enable `os`, `io`, `require`, `dofile`, or `loadfile`.
- Do not assume packet length; check offset + field size before reads.
- Do not change `FieldValue` from `#[serde(untagged)]` without frontend migration.
- Do not add `unwrap()` in parser/Lua paths; use `AppError::Protocol` with context.
- Do not update Rust types without updating `src/types/protocol.ts` and parser consumers.
