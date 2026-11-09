// Package the already-built Windows release using an explicit distribution list.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

if (process.platform !== 'win32') throw new Error('Windows portable packaging requires Windows.');
const root = path.resolve(import.meta.dirname, '..');
const release = path.join(root, 'src-tauri/target/release');
const executable = path.join(release, 'linkassist.exe');
const pe = fs.readFileSync(executable);
if (pe.toString('ascii', 0, 2) !== 'MZ') throw new Error('Expected a Windows release executable.');
const peOffset = pe.readUInt32LE(0x3c);
if (pe.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('Invalid PE header.');
const arch = new Map([[0x8664, 'x64'], [0xaa64, 'arm64'], [0x14c, 'x86']]).get(pe.readUInt16LE(peOffset + 4));
if (!arch) throw new Error('Unsupported PE architecture.');
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'third-party-licenses/inventory.json'), 'utf8'));
if (inventory.missingLicenseTexts.length) throw new Error('Resolve missing license texts before distribution.');
const targets = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc', x86: 'i686-pc-windows-msvc' };
if (inventory.target !== targets[arch]) throw new Error('License inventory target does not match the executable.');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid package version.');
const name = `LinkAssist-${version}-windows-${arch}-portable`;
const output = path.join(release, 'portable');
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(output, '.pack-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { windowsHide: true, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

const sevenZip = [
  process.env.LINKASSIST_7Z,
  path.join(process.env.ProgramFiles ?? 'C:/Program Files', '7-Zip/7z.exe'),
  '7z.exe',
].filter(Boolean).find(candidate => {
  const result = spawnSync(candidate, ['i'], { windowsHide: true, stdio: 'ignore' });
  return !result.error && result.status === 0;
});

try {
  const stage = path.join(temporary, name);
  fs.mkdirSync(stage);
  fs.copyFileSync(executable, path.join(stage, 'linkassist.exe'));
  for (const entry of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'third-party-licenses']) {
    fs.cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
  }
  fs.copyFileSync(path.join(root, 'docs/REMOTE-ACCESS.md'), path.join(stage, 'REMOTE-ACCESS.md'));
  fs.writeFileSync(path.join(stage, 'README.txt'),
    `LinkAssist ${version} — Windows ${arch}\r\n\r\n`
    + 'Extract the entire folder and run linkassist.exe. No app installation is needed.\r\n'
    + 'Microsoft Edge WebView2 Runtime must already be installed on the computer.\r\n'
    + 'Normal settings are stored in %APPDATA%/com.linkassist.desktop, not beside the EXE.\r\n'
    + 'Use the snapshot command to create a separate configuration snapshot.\r\n'
    + 'Keep LICENSE, THIRD_PARTY_NOTICES.md and third-party-licenses when redistributing.\r\n');
  const artifacts = [];
  for (const format of sevenZip ? ['zip', '7z'] : ['zip']) {
    const archive = path.join(temporary, `${name}.${format}`);
    if (sevenZip) {
      run(sevenZip, ['a', `-t${format}`, '-mx=9',
        ...(format === '7z' ? ['-m0=LZMA2', '-ms=on'] : ['-mm=Deflate']),
        archive, name], { cwd: temporary });
      run(sevenZip, ['t', archive]);
    } else {
      // Pass paths as environment data, never interpolate them into shell code.
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; '
        + '[IO.Compression.ZipFile]::CreateFromDirectory($env:LINKASSIST_STAGE, $env:LINKASSIST_ARCHIVE, '
        + '[IO.Compression.CompressionLevel]::Optimal, $true)'], {
        env: { ...process.env, LINKASSIST_STAGE: stage, LINKASSIST_ARCHIVE: archive },
      });
    }
    const data = fs.readFileSync(archive);
    const destination = path.join(output, path.basename(archive));
    fs.renameSync(archive, destination);
    artifacts.push({ file: path.basename(destination), bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex') });
  }
  fs.writeFileSync(path.join(output, `${name}.checksums.txt`),
    artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n');
  console.log(JSON.stringify({ executableBytes: pe.length, output, artifacts }, null, 2));
  if (!sevenZip) console.log('Install 7-Zip or set LINKASSIST_7Z to also generate the smaller .7z archive.');
} finally {
  // Only remove the fresh staging directory created by this invocation.
  if (path.dirname(temporary) !== output) throw new Error('Invalid staging directory.');
  fs.rmSync(temporary, { recursive: true, force: true });
}
