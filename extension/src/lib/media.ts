/** B站 image CDN hosts we accept for a cover reference. */
const IMAGE_HOSTS = ['hdslb.com', 'bilibili.com', 'biliapi.net'];

/**
 * Notion fetches a page cover server-side, so the reference must be an absolute https URL.
 * B站 returns covers as `http://i0.hdslb.com/…` (the old `startsWith('https://')` check dropped
 * those silently) and the page hook can hand us a protocol-relative `//…` value.
 */
export function normalizeCoverUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  let parsed: URL;
  try {
    parsed = new URL(value.startsWith('//') ? 'https:' + value : value);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  const host = parsed.hostname.toLowerCase();
  if (!IMAGE_HOSTS.some((suffix) => host === suffix || host.endsWith('.' + suffix))) return '';
  parsed.protocol = 'https:';
  parsed.hash = '';
  return parsed.toString();
}
