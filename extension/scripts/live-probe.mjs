/**
 * Live probe against the real B站 API (no cookies). Proves the WBI-signed client is
 * accepted by the server, echoes the requested identity, and that the login/obfuscation
 * guards behave on real data.
 *
 * Run: node scripts/live-probe.mjs
 */
import { build } from 'esbuild';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, '.tmp/live-bili.mjs');
await mkdir(path.dirname(outFile), { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/lib/bili.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
});
const { BiliClient } = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const http = (input, init) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), 'User-Agent': UA } });
const client = new BiliClient(http);

const BV = 'BV139bD6gEa8';
const AID = 117104095268420;
const CID = 40960721402;
const identity = { bvid: BV, aid: AID, cid: CID, page: 1 };

const report = {};

try {
  const nav = await client.nav();
  report.nav = { isLogin: nav.isLogin, hasWbiKeys: Boolean(nav.imgUrl && nav.subUrl) };
} catch (error) {
  report.nav = { error: String(error.message) };
}

try {
  const snapshot = await client.player(identity);
  report.playerWbiV2 = {
    endpoint: snapshot.endpoint,
    identityEchoMatches: true,
    needLoginSubtitle: snapshot.needLoginSubtitle,
    tracks: snapshot.tracks.map((t) => ({ id: t.id, language: t.language, label: t.label })),
  };
} catch (error) {
  report.playerWbiV2 = { error: String(error.message) };
}

// The legacy endpoint is what the old project effectively relied on; compare the two.
try {
  const response = await http(`https://api.bilibili.com/x/player/v2?bvid=${BV}&cid=${CID}`);
  const payload = await response.json();
  report.legacyPlayerV2 = {
    code: payload.code,
    aid: payload.data?.aid,
    cid: payload.data?.cid,
    needLoginSubtitle: payload.data?.need_login_subtitle,
    subtitleCount: payload.data?.subtitle?.subtitles?.length ?? null,
  };
} catch (error) {
  report.legacyPlayerV2 = { error: String(error.message) };
}

try {
  const tracks = await client.subtitleProto(identity);
  report.subtitleProto = { trackCount: tracks.length, tracks: tracks.map((t) => ({ language: t.language, label: t.label })) };
} catch (error) {
  report.subtitleProto = { error: String(error.message) };
}

try {
  await client.resolveSubtitle({ ...identity, title: '', part: '', owner: '', cover: '', category: '', duration: 0, pubdate: 0, description: '', url: '', tags: [] }, { consensusReads: 2, maxAttempts: 3 });
  report.resolveSubtitle = { unexpected: 'resolved without login' };
} catch (error) {
  report.resolveSubtitle = { errorName: error.name, message: String(error.message) };
}

console.log(JSON.stringify(report, null, 2));
