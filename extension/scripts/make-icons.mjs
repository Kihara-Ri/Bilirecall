import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { generateIcons } from './icons.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'assets/icons');
const svg = await readFile(path.join(sourceDir, 'bilirecall.svg'));
// 直接按目标尺寸渲染矢量，避免缩放旧位图带入纹理和透明度瑕疵。
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  for (const size of [16, 32, 48, 128, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;width:100vw;height:100vh}</style><img src="data:image/svg+xml;base64,${svg.toString('base64')}">`);
    await page.locator('img').evaluate((img) => img.decode());
    await page.screenshot({ path: path.join(sourceDir, size === 512 ? 'bilirecall-master.png' : `icon${size}.png`), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
await generateIcons(path.join(root, 'public/icons'));
console.log('vector icons rendered');
