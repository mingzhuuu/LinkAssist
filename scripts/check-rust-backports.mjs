import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export async function checkBackports() {
  const manifest = JSON.parse(await readFile(path.join(root, 'vendor/backports.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.packages.map(p => p.name), ['glib', 'glib-macros', 'gtk3-macros']);
  for (const pkg of manifest.packages) {
    const directory = path.join(root, 'vendor', pkg.name);
    const paths = [];
    async function walk(relative = '') {
      for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
        assert.ok(!entry.isSymbolicLink(), `Vendor symlink: ${entry.name}`);
        const file = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await walk(file);
        else paths.push(file);
      }
    }
    await walk();
    assert.deepEqual(paths.sort(), Object.keys(pkg.files).sort(), `${pkg.name}: file set changed`);
    for (const [file, hashes] of Object.entries(pkg.files)) {
      const digest = createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex');
      assert.equal(digest, hashes.patched, `${pkg.name}/${file}: unreviewed change`);
    }
    const cargo = await readFile(path.join(directory, 'Cargo.toml'), 'utf8');
    assert.ok(cargo.includes(`version = "${pkg.version}"`));
    assert.doesNotMatch(cargo, /\[dependencies\.proc-macro-error2?\]/);
    for (const [name, prefix] of [['src-tauri/Cargo.toml', '../vendor/'], ['vendor/Cargo.toml', '']]) {
      const text = await readFile(path.join(root, name), 'utf8');
      const patch = text.split('[patch.crates-io]')[1]?.split(/\n\[/)[0];
      assert.ok(patch?.includes(`${pkg.name} = { path = "${prefix}${pkg.name}" }`), `${name}: missing local patch`);
    }
  }
  for (const file of ['src-tauri/Cargo.lock', 'vendor/Cargo.lock']) {
    const lock = await readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(lock, /name = "proc-macro-error(?:-attr)?2?"/, `${file}: abandoned dependency returned`);
    for (const pkg of manifest.packages) {
      const blocks = lock.split('[[package]]').filter(block => block.startsWith(`\nname = "${pkg.name}"\n`));
      assert.equal(blocks.length, 1, `${file}: unexpected ${pkg.name} resolution`);
      assert.ok(blocks[0].includes(`version = "${pkg.version}"\n`));
      assert.doesNotMatch(blocks[0], /^source = /m, `${file}: ${pkg.name} is not the local patch`);
    }
  }
  const variant = await readFile(path.join(root, 'vendor/glib/src/variant_iter.rs'), 'utf8');
  assert.ok(variant.includes('let mut p: *mut libc::c_char = std::ptr::null_mut();'));
  assert.ok(variant.includes('                &mut p,'));
  console.log('GTK backports: source hashes, Cargo patches and lockfiles verified.');
  return manifest;
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  await checkBackports();
}
