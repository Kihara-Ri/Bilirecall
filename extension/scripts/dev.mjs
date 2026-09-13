/**
 * Dev loop with hot reload.
 *
 *   npm run dev            watch src/ + public/, rebuild, then bring the browser back up on the new build
 *   npm run dev -- --once  rebuild once and ask a running dev session to reload, then exit
 *   npm run dev -- --smoke self-check the whole loop headlessly (build → reload → prove the new bytes)
 *
 * Why relaunch instead of chrome.runtime.reload(): an extension loaded through --load-extension is not
 * registered in the profile, so Chrome *unloads* it on reload and never brings it back (verified: the
 * service worker list goes empty and extension URLs start returning ERR_BLOCKED_BY_CLIENT). Restarting
 * the browser is the only mechanism that reliably re-reads dist/. The dedicated profile
 * (.tmp/dev-profile) keeps cookies, B站 登录态 and chrome.storage.local across restarts, and the open B站
 * tags are reopened afterwards, so a save costs a couple of seconds and no manual click.
 *
 * DEV_HEADLESS=1 runs the loop without a window (handy for CI / for driving it from a script).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const profile = process.env.DEV_PROFILE ? path.resolve(process.env.DEV_PROFILE) : path.join(root, '.tmp/dev-profile');
const sandbox = path.join(root, '.tmp');
const statePath = path.join(sandbox, 'dev-session.json');
const triggerPath = path.join(sandbox, 'dev-reload');
const args = process.argv.slice(2);
const once = args.includes('--once');
const smoke = args.includes('--smoke');
const headless = process.env.DEV_HEADLESS === '1' || smoke;

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...parts) => console.log('[' + stamp() + ']', ...parts);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const distHash = () => hashOf(readFileSync(path.join(dist, 'popup.js'), 'utf8'));

/** Full rebuild — the same command the release build runs, so dev and shipped bundles cannot drift. */
function buildOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * Chrome derives an unpacked extension's id from its absolute path, so the id is stable across
 * restarts (the e2e uses the same derivation). A running worker or extension page wins if we see one —
 * MV3 service workers are lazy, so on a fresh profile there may be nothing to look at yet.
 */
function pathDerivedId() {
  return [...createHash('sha256').update(dist).digest('hex').slice(0, 32)]
    .map((char) => String.fromCharCode(97 + parseInt(char, 16)))
    .join('');
}

async function extensionId(context, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found =
      context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://')) ??
      context.pages().find((item) => item.url().startsWith('chrome-extension://'));
    if (found) return new URL(found.url()).host;
    await wait(200);
  }
  return pathDerivedId();
}

/** Reads popup.js *through the running extension*, so a stale build shows up as a hash mismatch. */
async function servedHash(context, id) {
  const page = await context.newPage();
  try {
    await page.goto('chrome-extension://' + id + '/options.html', { waitUntil: 'load', timeout: 10000 });
    return await page.evaluate(async () => (await fetch(chrome.runtime.getURL('popup.js'))).text()).then(hashOf);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function launch({ profileDir = profile, viewport = null } = {}) {
  mkdirSync(profileDir, { recursive: true });
  if (existsSync(path.join(profileDir, 'SingletonLock'))) {
    throw new Error(
      'profile ' + profileDir + ' is already open in another dev session — stop it (Ctrl+C) or set DEV_PROFILE=… for a second one',
    );
  }
  return chromium.launchPersistentContext(profileDir, {
    // Bundled Chromium is required: branded Chrome (M137+) ignores --load-extension.
    channel: 'chromium',
    headless,
    viewport,
    args: [
      '--disable-extensions-except=' + dist,
      '--load-extension=' + dist,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
}

const isBili = (url) => /^https?:\/\/([a-z0-9-]+\.)*bilibili\.com\//.test(url);

/**
 * Reload = restart the browser on the same profile and put the B站 标签页 back. Returns the
 * served-bundle hash so the caller can prove the new code is what the extension is actually running.
 */
async function reload(context, tabs) {
  const openTabs = context.pages().filter((page) => !page.isClosed() && isBili(page.url())).map((page) => page.url());
  await context.close().catch(() => undefined);
  const next = await launch();
  const id = await extensionId(next);
  for (const url of [...new Set([...openTabs, ...tabs])].slice(0, 5)) {
    await next.newPage().then((page) => page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined));
  }
  return { context: next, id, served: await servedHash(next, id), tabCount: openTabs.length };
}

// ---------------------------------------------------------------- self check
if (smoke) {
  const failures = [];
  const smokeProfile = path.join(sandbox, 'dev-profile-smoke');
  rmSync(smokeProfile, { recursive: true, force: true });
  await buildOnce();

  let context = await launch({ profileDir: smokeProfile });
  let id = await extensionId(context);
  const before = await servedHash(context, id).catch((error) => 'error: ' + error.message.split('\n')[0]);
  if (before !== distHash()) failures.push('the browser was not serving the freshly built popup.js (' + before + ' vs ' + distHash() + ')');

  // Change dist behind the browser's back, let the loop reload, and demand the new bytes show up.
  writeFileSync(path.join(dist, 'popup.js'), readFileSync(path.join(dist, 'popup.js'), 'utf8') + '// hot-reload-probe ' + Date.now() + '\n');
  ({ context, id } = await reload(context, []));
  const after = await servedHash(context, id).catch((error) => 'error: ' + error.message.split('\n')[0]);
  if (after !== distHash()) failures.push('the reload did not pick up the changed bundle (' + after + ' vs ' + distHash() + ')');

  console.log(
    failures.length
      ? 'hot reload FAILED: ' + failures.join('; ')
      : 'hot reload works: popup.js ' + before + ' → ' + after + ' with no manual reload',
  );
  await context.close();
  await buildOnce(); // drop the probe marker again
  rmSync(smokeProfile, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}

// ---------------------------------------------------------------- one shot
if (once) {
  if (!(await buildOnce())) process.exit(1);
  const running = existsSync(statePath);
  writeFileSync(triggerPath, String(Date.now()));
  log('built · ' + (running ? 'asked the dev session to reload' : 'no dev session running — start `npm run dev`'));
  process.exit(running ? 0 : 1);
}

// ---------------------------------------------------------------- watch mode
await buildOnce();
let context;
try {
  context = await launch();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const tabs = [];
let id = await extensionId(context);
let served = await servedHash(context, id).catch(() => null);
mkdirSync(sandbox, { recursive: true });
writeFileSync(statePath, JSON.stringify({ pid: process.pid, id, startedAt: Date.now() }, null, 2));
log('dev browser up · extension', id, '· profile ' + path.relative(root, profile) + (headless ? ' · headless' : ''));
log('popup.js ' + served + (served === distHash() ? ' ✓' : ' ⚠ (disk ' + distHash() + ')'));
log('watching src/ + public/ —— 改完自动重建并热重载（Ctrl+C 退出）');

async function reloadNow(reason) {
  log(reason + ' → rebuilding…');
  if (!(await buildOnce())) {
    log('build failed — keeping the previous build');
    return;
  }
  ({ context, id, served } = await reload(context, tabs));
  const expected = distHash();
  const ok = served === expected;
  log('hot reload done · popup.js ' + served + (ok ? ' ✓' : ' ✗ (disk ' + expected + ')'));
  if (!ok) log('the extension is not running the fresh build — check the profile in chrome://extensions');
}

let timer = null;
let pending = null;
const schedule = (reason) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (pending) return;
    pending = reloadNow(reason).finally(() => {
      pending = null;
    });
  }, 250);
};

for (const target of [path.join(root, 'src'), path.join(root, 'public'), path.join(root, 'scripts/icons.mjs')]) {
  if (!existsSync(target)) continue;
  watch(target, { recursive: statSync(target).isDirectory() }, () => schedule('change in ' + path.basename(target)));
}
// `npm run dev -- --once` drops this file, so another process can drive the loop.
rmSync(triggerPath, { force: true });
watch(sandbox, (event, file) => {
  if (file === path.basename(triggerPath) && existsSync(triggerPath)) {
    rmSync(triggerPath, { force: true });
    schedule('external reload request');
  }
});

const shutdown = async () => {
  console.log();
  log('bye');
  rmSync(statePath, { force: true });
  rmSync(triggerPath, { force: true });
  await context.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
