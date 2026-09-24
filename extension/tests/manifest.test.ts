import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 发布标准（商店审查会遇到的那几条）用代码钉住：
 * 权限最小化、没有远端代码、图标尺寸、描述长度、内容脚本范围。
 * 这些以前只靠人工检查 README，改成测试后每次改 manifest 都会被拦一次。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'public/manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** 源码全文（含 .ts/.tsx），用于“这个权限到底有没有被用”。 */
function sourceText(): string {
  const files = readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => path.join(root, 'src', name));
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}

/** 每个权限对应的 Chrome API；新增权限必须在这里写清楚用途，否则测试失败。 */
const PERMISSION_API: Record<string, string> = {
  storage: 'chrome.storage',
  unlimitedStorage: 'chrome.storage',
  alarms: 'chrome.alarms',
  tabs: 'chrome.tabs',
  notifications: 'chrome.notifications',
  activeTab: 'chrome.tabs',
};

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('store readiness', () => {
  it('is MV3 and keeps manifest/package versions in step', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.background.type).toBe('module');
  });

  it('requests no permission the code does not use', () => {
    const source = sourceText();
    const unused: string[] = [];
    for (const permission of manifest.permissions as string[]) {
      const api = PERMISSION_API[permission];
      if (!api) {
        unused.push(`${permission}（未在 PERMISSION_API 里登记用途）`);
        continue;
      }
      if (!source.includes(api)) unused.push(`${permission}（源码里没有出现 ${api}）`);
    }
    expect(unused).toEqual([]);
  });

  it('does not ask for cookies (login state comes from the nav endpoint)', () => {
    // 回归：这个权限从来没被用过，README 却说它用于判断登录 —— 商店按最小权限审查会直接质疑。
    expect(manifest.permissions).not.toContain('cookies');
    expect(sourceText()).not.toContain('chrome.cookies');
  });

  it('declares optional hosts that the settings page can actually request', () => {
    // 请求未声明的 origin，chrome.permissions.request 会静默返回 false（连弹窗都没有）。
    // 本地模型通常是 http://127.0.0.1:11434，必须在这里声明才可能授权。
    expect(manifest.optional_host_permissions).toEqual(
      expect.arrayContaining(['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']),
    );
    const source = sourceText();
    expect(source).toContain('chrome.permissions.request');
    expect(source).toContain('chrome.permissions.contains');
  });

  it('keeps host permissions narrow', () => {
    const hosts = manifest.host_permissions as string[];
    expect(hosts).toEqual(['https://*.bilibili.com/*', 'https://*.hdslb.com/*', 'https://api.notion.com/*']);
    for (const host of [...hosts, ...(manifest.optional_host_permissions as string[])]) {
      expect(host).not.toMatch(/<all_urls>|\*:\/\/\*\/\*/);
    }
  });

  it('runs on the video pages only, and injects the hook in the page world', () => {
    const [hook, content] = manifest.content_scripts;
    expect(hook.world).toBe('MAIN');
    expect(hook.js).toEqual(['inject.js']);
    expect(hook.matches).toEqual(content.matches);
    for (const match of content.matches as string[]) {
      expect(match).toMatch(/^https:\/\/www\.bilibili\.com\//);
    }
  });

  it('ships icons in all four sizes the store requires', () => {
    for (const size of [16, 32, 48, 128]) {
      const file = path.join(root, 'public/icons', `icon${size}.png`);
      expect(pngSize(file)).toEqual({ width: size, height: size });
      expect(manifest.icons[String(size)]).toBe(`icons/icon${size}.png`);
      expect(manifest.action.default_icon[String(size)]).toBe(`icons/icon${size}.png`);
    }
  });

  it('keeps the description inside the store limit and names the single purpose', () => {
    expect(manifest.description.length).toBeLessThanOrEqual(132);
    expect(manifest.name).toContain('BiliRecall');
  });

  it('loads no remote code and uses no eval', () => {
    const source = sourceText();
    expect(source).not.toMatch(/\beval\(|new Function\(/);
    expect(JSON.stringify(manifest)).not.toMatch(/unsafe-eval|content_security_policy/);
    // 注入脚本必须是打包好的文件，不能是远端地址。
    for (const entry of manifest.content_scripts) {
      for (const file of entry.js as string[]) expect(file.endsWith('.js')).toBe(true);
    }
  });
});
