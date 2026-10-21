import { readFile, readdir, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Deliberately scoped to application-owned text: never walk build/dependency/vendor trees.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFile(path.join(root, file), 'utf8');
const errors = [];
const textExtensions = new Set(['.ts', '.tsx', '.rs', '.md', '.lua', '.json', '.csv', '.css', '.mjs', '.toml']);
async function walk(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (['node_modules', 'target', 'dist', '.git'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await walk(relative));
    else if (textExtensions.has(path.extname(entry.name))) files.push(relative);
  }
  return files;
}

const files = (await Promise.all(['src', 'src-tauri/src', 'config', 'scripts'].map(walk))).flat().sort();
const sources = new Map(await Promise.all(files.map(async file => [file, await read(file)])));
const lib = sources.get('src-tauri/src/lib.rs');
const handler = lib.match(/generate_handler!\[([\s\S]*?)\]/)?.[1];
if (!handler) throw new Error('Tauri command registry not found');
const registrations = handler.split(',').map(item => item.trim()).filter(Boolean);
const commands = new Map(registrations.map(symbol => {
  const parts = symbol.split('::');
  return [parts.at(-1), parts.length === 1 ? 'src-tauri/src/lib.rs' : `src-tauri/src/${parts.slice(0, -1).join('/')}.rs`];
}));
if (commands.size !== registrations.length) errors.push('Duplicate registered Tauri command names');

// Inspect TS syntax, not comments/strings. Dynamic invoke names are explicitly outside this check.
let literalInvokes = 0;
let dynamicInvokes = 0;
for (const [file, source] of sources) {
  if (!/\.tsx?$/.test(file) || file.startsWith('src/__tests__/')) continue;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const invokeNames = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (module === '@tauri-apps/api/core' && bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'invoke') invokeNames.add(element.name.text);
      }
    }
    if (file.startsWith('src/stores/') && !statement.importClause?.isTypeOnly && module.startsWith('.')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), module));
      const typeOnly = bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly);
      if (!typeOnly && (target === 'src/stores' || target.startsWith('src/stores/'))) {
        errors.push(`${file}: store-to-store runtime import ${module}`);
      }
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && invokeNames.has(node.expression.text)) {
      const argument = node.arguments[0];
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        literalInvokes++;
        if (!argument.text.startsWith('plugin:') && !commands.has(argument.text)) {
          errors.push(`${file}: unregistered Tauri command ${argument.text}`);
        }
      } else dynamicInvokes++;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

const declaredCommands = new Set();
for (const [file, source] of sources) {
  if (!file.endsWith('.rs')) continue;
  for (const match of source.matchAll(/#\[tauri::command\]\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/g)) {
    declaredCommands.add(`${file}:${match[1]}`);
    if (commands.get(match[1]) !== file) errors.push(`${file}: command ${match[1]} is not registered`);
  }
}
for (const [name, file] of commands) {
  if (!declaredCommands.has(`${file}:${name}`)) errors.push(`${name}: registered handler has no command declaration in ${file}`);
}

const definitions = sources.get('src-tauri/src/mcp_tools.rs')
  .split('fn builtin_tool_definitions()')[1]?.split('pub async fn call_tool(')[0];
if (!definitions) throw new Error('MCP built-in definitions not found');
const tools = [...definitions.matchAll(/tool\(\s*"([^"]+)",\s*"((?:\\.|[^"\\])*)"/g)]
  .map(match => ({ name: match[1], description: match[2] }));
if (!tools.length) throw new Error('No built-in MCP tools extracted');

const packageJson = JSON.parse(await read('package.json'));
const lock = JSON.parse(await read('package-lock.json'));
const rustMinimum = (await read('src-tauri/Cargo.toml')).match(/rust-version\s*=\s*"([^"]+)"/)[1];
const relativeLink = file => `../${file}`;
const reference = [
  '# 源码接口与文件索引', '',
  '> 自动生成：`npm run docs:generate`；校验：`npm run check:architecture`。不要手工维护接口名单。', '',
  '此索引只列应用自有源码、配置示例和维护脚本；不扫描依赖、构建产物和上游数据仓库。', '',
  '## 构建契约', '',
  `- 应用版本：${packageJson.version}。Rust 最低版本：${rustMinimum}（Cargo.toml）。`,
  ...['vite', 'vitest', 'jsdom'].map(name => {
    const dependency = lock.packages[`node_modules/${name}`];
    return `- ${name} 锁定版本：${dependency.version}；Node.js 范围：\`${dependency.engines.node}\`。`;
  }), '',
  `## Tauri 命令（${commands.size}）`, '',
  '前端 invoke 名称以此表为准；参数和返回值仍需核对函数签名及 serde 定义。', '',
  '| 命令 | 实现 |', '|---|---|',
  ...[...commands].map(([name, file]) => `| \`${name}\` | [${file}](${relativeLink(file)}) |`), '',
  `## MCP 内置工具（${tools.length}）`, '',
  '以下为静态内置工具，不含按用户配置加载的 Lua 工具。运行时启用状态和参数 schema 以 tools/list 为准。', '',
  '| 工具 | 源码说明 |', '|---|---|',
  ...tools.map(tool => `| \`${tool.name}\` | ${tool.description.replaceAll('|', '\\|')} |`), '',
  `## 应用文件（${files.length}）`, '',
  '目录职责见 [架构说明](ARCHITECTURE.md)。根目录构建入口另见 [开发与验证](DEVELOPMENT.md)。', '',
  ...files.map(file => `- [${file}](${relativeLink(file)})`), '',
].join('\n');

const generatedFile = 'docs/REFERENCE.md';
if (process.argv.includes('--write')) {
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, generatedFile), reference);
} else {
  const existing = await read(generatedFile).catch(() => '');
  if (existing.replace(/\r\n/g, '\n') !== reference) errors.push('Generated reference is stale; run npm run docs:generate');
}

// Check owned documentation links only. External URLs and heading-only links are not fetched.
const documents = ['README.md', 'README_EN.md', ...await walk('docs')];
for (const file of documents.filter(file => file.endsWith('.md'))) {
  const source = (await read(file)).replace(/```[\s\S]*?```/g, '');
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = match[1].split('#')[0];
    if (!link || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(link)) continue;
    const destination = path.resolve(root, path.dirname(file), decodeURIComponent(link));
    try { await access(destination); }
    catch { errors.push(`${file}: missing linked file ${link}`); }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Architecture check passed: ${commands.size} commands, ${tools.length} built-in MCP tools, ${literalInvokes} literal invokes; ${dynamicInvokes} dynamic invokes require review.`);
}
