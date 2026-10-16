import { api, type LaunchItemIn } from '@/lib/api';

// The launchpad's art step (web): read the files a creator picked, pair each
// image with its traits, and upload images straight to IPFS through one-off
// signed URLs from our server. Traits can come from:
// - JSON files named like the images (1.png + 1.json, as HashLips and most
//   generators write them: { name, attributes: [{ trait_type, value }] }), or
// - one CSV with a `file` (or `index`) column, an optional `name` column and
//   one column per trait.
// Images are ordered by number in the filename (1, 2, … 10), so artwork #N is
// the Nth image.

export type Attr = { trait_type: string; value: string | number };
export type PickedItem = { idx: number; file: File; name?: string; attributes: Attr[] };
export type Picked = { items: PickedItem[]; problems: string[]; traitSource: 'json' | 'csv' | 'none' };

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|mp4|glb)$/i;
const base = (n: string) => n.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
const num = (n: string) => {
  const m = /(\d+)(?!.*\d)/.exec(base(n));
  return m ? Number(m[1]) : Number.NaN;
};
const naturalCmp = (a: File, b: File) => {
  const x = num(a.name), y = num(b.name);
  if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x - y;
  return a.name.localeCompare(b.name, undefined, { numeric: true });
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export async function readPicked(files: File[]): Promise<Picked> {
  const problems: string[] = [];
  const images = files.filter((f) => IMAGE.test(f.name)).sort(naturalCmp);
  const jsons = new Map(files.filter((f) => /\.json$/i.test(f.name)).map((f) => [base(f.name), f]));
  const csv = files.find((f) => /\.csv$/i.test(f.name));
  let traitSource: Picked['traitSource'] = 'none';
  const byName = new Map<string, { name?: string; attributes: Attr[] }>();

  if (csv) {
    traitSource = 'csv';
    const rows = parseCsv(await csv.text());
    const head = (rows.shift() ?? []).map((h) => h.trim());
    const fileCol = head.findIndex((h) => /^(file|filename|image|index|id|token_?id)$/i.test(h));
    const nameCol = head.findIndex((h) => /^name$/i.test(h));
    if (fileCol < 0) problems.push('The CSV needs a "file" (or "index") column to match rows to images.');
    else {
      for (const r of rows) {
        const key = base(r[fileCol] ?? '').trim();
        const attributes = head.map((h, i) => ({ h, i })).filter(({ i }) => i !== fileCol && i !== nameCol && (r[i] ?? '').trim() !== '')
          .map(({ h, i }) => ({ trait_type: h, value: r[i].trim() }));
        byName.set(key, { name: nameCol >= 0 ? r[nameCol]?.trim() || undefined : undefined, attributes });
      }
    }
  } else if (jsons.size) {
    traitSource = 'json';
    for (const img of images) {
      const j = jsons.get(base(img.name));
      if (!j) continue;
      try {
        const meta = JSON.parse(await j.text()) as { name?: string; attributes?: Attr[] };
        byName.set(base(img.name), {
          name: typeof meta.name === 'string' ? meta.name : undefined,
          attributes: Array.isArray(meta.attributes) ? meta.attributes.filter((a) => a && a.trait_type != null && a.value != null).slice(0, 50) : [],
        });
      } catch { problems.push(`${j.name} isn't valid JSON.`); }
    }
  }

  const items = images.map((file, i) => {
    const t = byName.get(base(file.name)) ?? (traitSource === 'csv' ? byName.get(String(i + 1)) : undefined);
    return { idx: i + 1, file, name: t?.name, attributes: t?.attributes ?? [] };
  });
  if (traitSource !== 'none') {
    const missing = items.filter((it) => !byName.has(base(it.file.name)) && !(traitSource === 'csv' && byName.has(String(it.idx)))).length;
    if (missing) problems.push(`${missing} image${missing === 1 ? ' has' : 's have'} no traits in the ${traitSource.toUpperCase()}.`);
  }
  const big = items.filter((it) => it.file.size > 15_000_000).length;
  if (big) problems.push(`${big} file${big === 1 ? ' is' : 's are'} over 15 MB; shrink them first.`);
  return { items, problems, traitSource };
}

/** Trait → value → count, for a rarity preview. */
export function traitCounts(items: { attributes: Attr[] }[]) {
  const out = new Map<string, Map<string, number>>();
  for (const it of items) for (const a of it.attributes) {
    const m = out.get(a.trait_type) ?? out.set(a.trait_type, new Map()).get(a.trait_type)!;
    m.set(String(a.value), (m.get(String(a.value)) ?? 0) + 1);
  }
  return out;
}

/** Each attempt gets a fresh signed URL (`getUrl`): Pinata can refuse a URL that has already been tried. */
async function uploadOne(getUrl: () => Promise<string>, file: File): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    // Name it explicitly: files from a folder pick otherwise go up as "folder/1.gif", which Pinata
    // reads as a directory upload and refuses ("detected MIME type: directory").
    form.append('file', file, file.name);
    form.append('network', 'public');
    const res = await fetch(await getUrl(), { method: 'POST', body: form }).catch(() => null);
    if (res?.ok) return ((await res.json()) as { data: { cid: string } }).data.cid;
    const why = res ? (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160) : '';
    if (res) console.warn('[upload]', file.name, file.type, file.size, res.status, why);
    if (attempt >= 3) throw new Error(`Upload failed for ${file.name}${res ? ` (${res.status}${why ? `: ${why}` : ''})` : ''}.`);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

/** Upload one file (cover, banner, placeholder) and return its CID. */
export async function uploadSingle(userId: string, launchId: string, file: File) {
  return uploadOne(async () => (await api.launchSign(userId, launchId, 1, 'image')).urls[0], file);
}

/**
 * Upload every artwork, then save the list (CIDs + traits) on the draft in batches.
 * `onProgress(done, total)`; `signal` stops between files.
 */
export async function uploadArt(userId: string, launchId: string, items: PickedItem[], onProgress: (done: number, total: number) => void, signal?: { stop: boolean }) {
  const total = items.length;
  let done = 0;
  const out: LaunchItemIn[] = new Array(total);
  const queue = [...items];
  const urls: string[] = [];
  const nextUrl = async () => {
    if (!urls.length) urls.push(...(await api.launchSign(userId, launchId, Math.min(50, queue.length + 4), 'art')).urls);
    return urls.pop()!;
  };
  const worker = async () => {
    for (;;) {
      if (signal?.stop) return;
      const it = queue.shift();
      if (!it) return;
      const cid = await uploadOne(nextUrl, it.file);
      out[it.idx - 1] = { idx: it.idx, cid, mime: it.file.type || undefined, name: it.name, attributes: it.attributes };
      onProgress(++done, total);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (signal?.stop) throw new Error('Upload stopped.');
  for (let i = 0; i < out.length; i += 200) await api.launchItems(userId, launchId, out.slice(i, i + 200));
  await api.launchTrim(userId, launchId, total);
  return out;
}
