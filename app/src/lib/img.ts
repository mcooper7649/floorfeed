// NFT art is often multi-megabyte originals on slow or blocked hosts (a Mad
// Lads PNG is ~7 MB; arweave sandbox subdomains are on some DNS blocklists).
// Serve a resized copy instead: OpenSea's CDN takes a width param, everything
// else goes through Magic Eden's public image proxy.
const STEPS = [128, 256, 512, 1024];

export function thumb(uri: string | null, px: number): string | null {
  if (!uri || !/^https?:\/\//.test(uri)) return uri;
  const w = STEPS.find((s) => s >= px) ?? 1024;
  if (/\.seadn\.io\//.test(uri)) return `${uri.split('?')[0]}?w=${w}`;
  return `https://img-cdn.magiceden.dev/rs:fill:${w}:${w}:0:0/plain/${uri}`;
}
