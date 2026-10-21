// Preserve upstream license/notice texts alongside a reproducible dependency inventory.
// Run after npm ci and cargo fetch/build for the selected target.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const target = process.env.LINKASSIST_LICENSE_TARGET ?? 'x86_64-pc-windows-msvc';
const result = spawnSync('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml',
  '--format-version', '1', '--locked', '--filter-platform', target], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Cargo metadata failed');
const cargo = JSON.parse(result.stdout);
const selected = new Set(cargo.resolve.nodes.map(node => node.id));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const inventory = [];
const sections = [];
const missing = [];
const supplements = JSON.parse(fs.readFileSync('third-party-licenses/upstream/sources.json', 'utf8'));

function add(ecosystem, name, version, license, directory, explicitFile) {
  const filenames = new Set(fs.readdirSync(directory).filter(file => /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(file)));
  if (explicitFile) filenames.add(explicitFile);
  const texts = [];
  for (const filename of [...filenames].sort()) {
    const file = path.resolve(directory, filename);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      texts.push(`--- ${path.basename(filename)} ---\n${fs.readFileSync(file, 'utf8')}`);
    }
  }
  const supplement = supplements[`${name}@${version}`];
  if (!texts.length && supplement) {
    texts.push(`Upstream source: ${supplement.source}\nLicense source: ${supplement.url}\n\n${fs.readFileSync(path.join('third-party-licenses/upstream', supplement.file), 'utf8')}`);
  }
  inventory.push({ ecosystem, name, version, license: license ?? 'UNSPECIFIED', licenseFiles: [...filenames].map(file => path.basename(file)).sort(), ...(supplement ? { upstream: supplement } : {}) });
  if (!texts.length) missing.push(`${ecosystem}:${name}@${version} (${license ?? 'UNSPECIFIED'})`);
  sections.push(`===== ${ecosystem}: ${name} ${version} =====\nDeclared license: ${license ?? 'UNSPECIFIED'}\n\n${texts.join('\n\n') || 'No license text shipped at package root. Consult the upstream package source.'}`);
}

for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location || pkg.dev || !fs.existsSync(path.join(root, location, 'package.json'))) continue;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, location, 'package.json'), 'utf8'));
  add('npm', manifest.name, pkg.version, pkg.license ?? manifest.license, path.join(root, location));
}
for (const pkg of cargo.packages.filter(pkg => selected.has(pkg.id) && pkg.name !== 'linkassist')
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
  add('cargo', pkg.name, pkg.version, pkg.license, path.dirname(pkg.manifest_path), pkg.license_file);
}
for (const [name, commit] of [
  ['bluetooth-numbers-database', 'f775114b057960b5f62d15c594c9335d112cb101'],
  ['registries', '228b62c31c177c9b770b79896aec9ef660f62216'],
]) {
  const license = path.join(name, 'LICENSE');
  if (!fs.existsSync(license)) throw new Error(`Initialize submodules before generating notices: ${name}`);
  add('dataset', name, commit, name === 'registries' ? 'Apache-2.0' : 'BSD-3-Clause', name);
}
const output = 'third-party-licenses';
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'inventory.json'), JSON.stringify({ target, packages: inventory, missingLicenseTexts: missing }, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'THIRD_PARTY_LICENSES.txt'), sections.join('\n\n') + '\n');
console.log(`Collected ${inventory.length} packages; ${missing.length} require upstream license-text review.`);
if (missing.length) console.log(missing.join('\n'));
if (missing.length) process.exitCode = 1;
