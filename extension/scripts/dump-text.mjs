import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.tmp/shots');
const browser = await chromium.launch({ channel: 'chromium', headless: true });

const popup = await browser.newPage({ viewport: { width: 396, height: 600 } });
await popup.emulateMedia({ colorScheme: 'light' });
await popup.goto(pathToFileURL(path.join(dir, 'harness-popup.html')).href, { waitUntil: 'load' });
await popup.waitForTimeout(300);
console.log('=== POPUP ===');
console.log(await popup.innerText('.popup'));

const options = await browser.newPage({ viewport: { width: 1000, height: 900 } });
await options.goto(pathToFileURL(path.join(dir, 'harness-options.html')).href, { waitUntil: 'load' });
await options.waitForTimeout(300);
console.log('\n=== OPTIONS / first record ===');
console.log(await options.innerText('.record'));

const viewer = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const key = encodeURIComponent('BV139bD6gEa8:40960721402');
await viewer.goto(pathToFileURL(path.join(dir, 'harness-viewer.html')).href + '?key=' + key, { waitUntil: 'load' });
await viewer.waitForTimeout(400);
console.log('\n=== VIEWER ===');
console.log((await viewer.innerText('.viewer')).slice(0, 1400));
await browser.close();
