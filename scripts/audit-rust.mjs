// cargo-audit skips path packages. Also audit their original registry identities,
// accepting only the specific upstream GLib defect fixed by the verified backport.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkBackports, root } from './check-rust-backports.mjs';

const manifest = await checkBackports();
await mkdir(path.join(root, 'logs'), { recursive: true });
const output = await mkdtemp(path.join(root, 'logs/rust-audit-'));
let fetch = true;
function audit(file, registryIdentities) {
  const command = process.env.CARGO_AUDIT || 'cargo';
  const args = ['audit', '--file', file, '--json', ...(fetch ? [] : ['--no-fetch'])];
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120_000 });
  if (result.error) throw result.error;
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error(result.stderr || result.stdout); }
  assert.ok(report.vulnerabilities && report.warnings && report.database?.['advisory-count'] > 0, 'Incomplete audit report');
  assert.equal(report.settings.ignore.length, 0, 'Do not configure global audit ignores');
  fetch = false;
  const findings = [
    ...report.vulnerabilities.list,
    ...Object.values(report.warnings).flat(),
  ];
  const unresolved = findings.filter(finding => !(registryIdentities
    && finding.advisory?.id === 'RUSTSEC-2024-0429'
    && finding.package.name === 'glib'
    && finding.package.version === '0.18.5'));
  return { report, unresolved, backported: findings.length - unresolved.length };
}

let failures = 0;
for (const [name, relative] of [['application', 'src-tauri/Cargo.lock'], ['backport-tests', 'vendor/Cargo.lock']]) {
  const lock = await readFile(path.join(root, relative), 'utf8');
  const shadow = lock.split('[[package]]').map(block => {
    const pkg = manifest.packages.find(p => block.startsWith(`\nname = "${p.name}"\n`));
    if (!pkg) return block;
    return block.replace(`version = "${pkg.version}"\n`, `version = "${pkg.version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${pkg.archiveSha256}"\n`);
  }).join('[[package]]');
  const shadowFile = path.join(output, `${name}-upstream.lock`);
  await writeFile(shadowFile, shadow);
  for (const [label, file, registryIdentities] of [['resolved', path.join(root, relative), false], ['upstream', shadowFile, true]]) {
    const result = audit(file, registryIdentities);
    await writeFile(path.join(output, `${name}-${label}.json`), JSON.stringify(result, null, 2) + '\n');
    console.log(`${name}/${label}: ${result.unresolved.length} unresolved; ${result.backported} verified backport(s).`);
    for (const finding of result.unresolved) console.error(JSON.stringify(finding));
    failures += result.unresolved.length;
  }
}
console.log(`Audit evidence: ${output}`);
if (failures) process.exitCode = 1;
