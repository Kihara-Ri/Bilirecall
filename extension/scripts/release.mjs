import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 一条命令发布：npm run release [-- --bump 1.2.0] [-- --notes 文件] [-- --dry]
 *
 * 步骤：工作区与登录态预检 → （可选 --bump：写 manifest 版本并提交）→ npm run verify
 * → 打包 dist 为 BiliRecall-v{version}.zip → 计算 SHA-256 → 生成发布说明
 * （--notes 缺省时取 开发日志.md 最新的「未发布」条目）→ 打 tag 并推送 → gh release create。
 * --dry 停在发布之前，只做预检、校验、打包与说明生成。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..');
const args = process.argv.slice(2);

const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const bump = flag('bump');
const notesFile = flag('notes');
const dry = args.includes('--dry');

const run = (cmd, cmdArgs, options = {}) =>
  execFileSync(cmd, cmdArgs, { stdio: options.capture ? 'pipe' : 'inherit', encoding: 'utf8', ...options });
const git = (cmdArgs, options = {}) => run('git', ['-C', repo, ...cmdArgs], options);

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 预检

if (!existsSync(path.join(root, 'public/manifest.json'))) fail('找不到 public/manifest.json');
const manifestPath = path.join(root, 'public/manifest.json');

if (git(['status', '--porcelain'], { capture: true }).trim()) {
  fail('工作区有未提交的改动：先提交或暂存（--bump 会自己提交版本号，其他改动请先处理）');
}
try {
  run('gh', ['auth', 'status'], { stdio: 'ignore' });
} catch {
  fail('gh 未登录：先运行 gh auth login');
}

// ---------------------------------------------------------------- 版本号

if (bump) {
  if (!/^\d+\.\d+\.\d+$/.test(bump)) fail(`--bump 需要 x.y.z 形式的版本号，收到：${bump}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = bump;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  git(['add', 'extension/public/manifest.json']);
  git(['commit', '-m', `chore: 发布 v${bump}`]);
  console.log(`✓ 版本号已写入并提交：v${bump}`);
}

const version = JSON.parse(await readFile(manifestPath, 'utf8')).version;
const tag = `v${version}`;
const zipPath = path.join(repo, `BiliRecall-v${version}.zip`);

const remoteTag = git(['ls-remote', '--tags', 'origin', tag], { capture: true }).trim();
if (remoteTag && !dry) fail(`远端已存在 ${tag}：请先提升 manifest 里的 version（或用 --bump）`);
if (remoteTag && dry) console.log(`! 远端已存在 ${tag}（dry 模式继续）`);

// ---------------------------------------------------------------- 校验 + 打包

console.log('✓ npm run verify（typecheck + 测试 + 构建）');
run('npm', ['run', 'verify'], { cwd: root });

const stage = path.join(os.tmpdir(), `bilirecall-${version}`);
await rm(stage, { recursive: true, force: true });
await cp(path.join(root, 'dist'), stage, { recursive: true });
run('find', [stage, '-name', '.DS_Store', '-delete']);
await rm(zipPath, { force: true });
run('zip', ['-r', '-X', '-q', zipPath, path.basename(stage)], { cwd: os.tmpdir() });

const digest = createHash('sha256').update(await readFile(zipPath)).digest('hex');
console.log(`✓ 打包完成：BiliRecall-v${version}.zip（SHA-256 ${digest.slice(0, 12)}…）`);

// ---------------------------------------------------------------- 发布说明

/** 取 开发日志.md 顶部条目作为正文；标题里的括号说明（如「历史同步自动调度」）用进 Release 标题。 */
async function defaultNotes() {
  const log = await readFile(path.join(root, '开发日志.md'), 'utf8');
  const start = log.indexOf('\n## ');
  const section = start >= 0 ? log.slice(start + 1) : '';
  const next = section.indexOf('\n## ');
  const entry = (next >= 0 ? section.slice(0, next) : section).trim();
  const headingMatch = entry.match(/^##\s*(?:未发布[^\n(（]*)?[（(]([^)）]+)[)）]/);
  const highlight = headingMatch?.[1] ?? '';
  return {
    title: `v${version}${highlight ? ` · ${highlight}` : ''}`,
    body: `${entry.replace(/^##[^\n]*\n/, '')}\n\n## 安装\n\n1. 下载下方的 \`BiliRecall-v${version}.zip\` 并解压\n2. Chrome 打开 \`chrome://extensions\`，开启右上角「开发者模式」\n3. 点「加载已解压的扩展程序」，选择解压出的 \`bilirecall-${version}\` 文件夹\n\n> Chrome 自 2014 年起禁止安装商店外的 \`.crx\` 单文件，「解压 + 加载已解压」是未上架扩展在 Chrome 上的唯一官方安装方式。\n\n## 校验\n\n\`\`\`\nSHA-256 (BiliRecall-v${version}.zip) = ${digest}\n\`\`\`\n`,
  };
}

const defaults = await defaultNotes();
const title = flag('title') ?? defaults.title;
const body = notesFile ? await readFile(path.resolve(process.cwd(), notesFile), 'utf8') : defaults.body;
const notesTmp = path.join(os.tmpdir(), `bilirecall-release-${version}.md`);
await writeFile(notesTmp, body);
console.log(`✓ 发布说明就绪（标题：${title}）`);

// ---------------------------------------------------------------- 发布

if (dry) {
  console.log('\n--dry 到此为止。接下来会执行：');
  console.log(`  git tag ${tag} && git push origin main && git push origin ${tag}`);
  console.log(`  gh release create ${tag} ${path.basename(zipPath)} --title "${title}" --notes-file ${notesTmp}`);
  process.exit(0);
}

git(['tag', '-a', tag, '-m', title]);
git(['push', 'origin', 'main']);
git(['push', 'origin', tag]);
const url = run('gh', ['release', 'create', tag, zipPath, '--title', title, '--notes-file', notesTmp], { capture: true }).trim();
console.log(`\n✓ 发布完成：${url}`);
console.log(`  SHA-256 = ${digest}`);
