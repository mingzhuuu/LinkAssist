// Compile the real patched proc macros without requiring GTK/GLib native libraries.
// Invalid input must emit the expected diagnostic, never a proc-macro panic.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'logs'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'logs/rust-macro-diagnostics-'));
const vendor = path.join(root, 'vendor').replaceAll('\\', '/');
await mkdir(path.join(directory, 'src'));
await writeFile(path.join(directory, 'Cargo.toml'), `[package]
name = "linkassist-macro-diagnostics"
version = "0.0.0"
edition = "2021"
[workspace]
[dependencies]
glib-macros = { path = "${vendor}/glib-macros" }
gtk3-macros = { path = "${vendor}/gtk3-macros" }
# Lets gtk3-macros resolve its emitted crate name without linking GTK on Windows.
gtk = { version = "=0.18.2", optional = true }
[patch.crates-io]
glib = { path = "${vendor}/glib" }
glib-macros = { path = "${vendor}/glib-macros" }
gtk3-macros = { path = "${vendor}/gtk3-macros" }
`);
await writeFile(path.join(directory, 'Cargo.lock'), await readFile(path.join(root, 'vendor/Cargo.lock')));
const cases = [
  ['clone-valid', 'fn main() { let value = String::from("ok"); let f = glib_macros::clone!(@strong value => move || value); assert_eq!(f(), "ok"); }', null],
  ['enum-kind', '#[derive(glib_macros::Enum)] struct Bad;', 'only supports enums'],
  ['enum-name', '#[derive(glib_macros::Enum)] enum Bad { A }', 'requires #[enum_type'],
  ['error-kind', '#[derive(glib_macros::ErrorDomain)] struct Bad;', 'only supports enums'],
  ['error-name', '#[derive(glib_macros::ErrorDomain)] enum Bad { A }', 'requires #[error_domain'],
  ['boxed-name', '#[derive(glib_macros::Boxed)] struct Bad;', 'requires #[boxed_type'],
  ['shared-shape', '#[derive(glib_macros::SharedBoxed)] struct Bad;', 'requires struct MyStruct'],
  ['shared-name', '#[derive(glib_macros::SharedBoxed)] struct Bad(std::sync::Arc<()>);', 'requires #[shared_boxed_type'],
  ['flags-kind', '#[glib_macros::flags(name = "Bad")] struct Bad;', 'only supports enums'],
  ...['object_subclass', 'object_interface', 'derived_properties'].flatMap(macro => [
    [`${macro}-parse`, `#[glib_macros::${macro}] struct Bad;`, 'This macro should be used on'],
    [`${macro}-trait`, `struct Bad; #[glib_macros::${macro}] impl Bad {}`, 'This macro should be used on'],
  ]),
  ['closure-keyword', 'fn main() { glib_macros::closure!(@wrong x => move || {}); }', 'Unknown keyword'],
  ['closure-self', 'fn main() { glib_macros::closure!(@strong self => move || {}); }', "Can't use `self`"],
  ['closure-field', 'fn main() { glib_macros::closure!(@strong x.y => move || {}); }', 'Field accesses are not allowed'],
  ['closure-watch', 'fn main() { glib_macros::closure!(@watch x, @watch y => move || {}); }', ['Only one `@watch`', 'Previous `@watch`']],
  ['closure-async', 'fn main() { glib_macros::closure!(async || {}); }', 'Async closure not allowed'],
  ['closure-move', 'fn main() { glib_macros::closure!(@strong x => || {}); }', 'Closure with captures needs'],
  ['variant-mode', '#[derive(glib_macros::Variant)] #[variant_enum(wrong)] enum Bad { A }', 'unknown type in #[variant_enum]'],
  ['variant-repr', '#[derive(glib_macros::Variant)] #[variant_enum(repr)] enum Bad { A }', 'Must have #[repr]'],
  ['variant-enum-data', '#[derive(glib_macros::Variant)] #[variant_enum(enum)] enum Bad { A(u8) }', 'only allowed with C-style enums'],
  ['variant-flags-data', '#[derive(glib_macros::Variant)] #[variant_enum(flags)] enum Bad { A(u8) }', 'only allowed with bitflags'],
  ['template-missing', '#[derive(gtk3_macros::CompositeTemplate)] struct Bad;', 'requires #[template'],
  ['template-kind', '#[derive(gtk3_macros::CompositeTemplate)] #[template(string = "")] enum Bad { A }', 'only supports structs'],
  ['template-field', '#[derive(gtk3_macros::CompositeTemplate)] #[template(string = "")] struct Bad { #[template_child(id = "x", id = "y")] child: () }', 'two instances of the same attribute'],
];
for (const [name, source, messages] of cases) {
  await writeFile(path.join(directory, 'src/main.rs'), source + (source.includes('fn main()') ? '\n' : '\nfn main() {}\n'));
  const result = spawnSync('cargo', ['check', '--offline', '--manifest-path', path.join(directory, 'Cargo.toml')], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, CARGO_TARGET_DIR: path.join(root, 'vendor/target') },
  });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  await writeFile(path.join(directory, `${name}.txt`), output);
  assert.doesNotMatch(output, /proc macro panicked|derive macro panicked|custom attribute panicked/i, name);
  assert.equal(result.status, messages === null ? 0 : 101, `${name}: ${output}`);
  for (const message of messages === null ? [] : [messages].flat()) assert.ok(output.includes(message), `${name}: ${output}`);
  console.log(`PASS ${name}`);
}
console.log(`${cases.length} macro diagnostic cases passed. Logs: ${directory}`);
