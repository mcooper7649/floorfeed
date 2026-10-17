import { randomUUID } from "node:crypto";
import { decodeErrorResult, encodeAbiParameters, encodeFunctionData, formatEther, getAddress, keccak256, parseEther, parseEventLogs, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { dropAbi, factoryAbi } from "./abi/launchpad.ts";
import { EVM_CHAINS } from "./config.ts";
import type { Drop } from "./discover.ts";
import { osChain } from "./opensea.ts";
import { usdPrice } from "./prices.ts";
import { db } from "./db.ts";
import { evmPublicClient, isTradableChain, simulateEvm } from "./trade-evm.ts";

// The launchpad: creators set up a PFP collection on FloorFeed (art on IPFS via
// Pinata, or on chain later), then deploy it from their own wallet through
// FloorFeedFactory (contracts/). FloorFeed stores the draft, pins metadata,
// builds the transactions and keeps allowlists for proofs; it never holds funds
// or creators' keys. Its one key, LAUNCH_PASS_KEY, only signs short-lived member
// passes for "FloorFeed members" phases (any signed-in account, a per-account limit
// enforced on chain); the factory owner can rotate or switch it off.
// Collections then mint here and show in the Mint hub.

db.exec(`
CREATE TABLE IF NOT EXISTS launches (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, creator TEXT, chain TEXT NOT NULL,
  name TEXT NOT NULL, symbol TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  website TEXT, twitter TEXT,
  royalty_bps INTEGER NOT NULL DEFAULT 500, royalty_to TEXT,
  storage TEXT NOT NULL DEFAULT 'ipfs',
  cover_cid TEXT, banner_cid TEXT, placeholder_cid TEXT,
  phases TEXT NOT NULL DEFAULT '[]',    -- JSON PhaseIn[] (allowlists live in launch_allow)
  reveal TEXT NOT NULL DEFAULT 'later', -- 'instant' | 'later'
  meta_cid TEXT, contract_uri TEXT, placeholder_uri TEXT, provenance TEXT,
  address TEXT, deploy_tx TEXT, status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS launches_user ON launches(user_id);
CREATE INDEX IF NOT EXISTS launches_address ON launches(address);
CREATE TABLE IF NOT EXISTS launch_items (
  launch_id TEXT NOT NULL, idx INTEGER NOT NULL, cid TEXT NOT NULL, mime TEXT,
  name TEXT, attributes TEXT,          -- JSON [{trait_type, value}]
  PRIMARY KEY (launch_id, idx)
);
CREATE TABLE IF NOT EXISTS launch_allow (
  launch_id TEXT NOT NULL, phase INTEGER NOT NULL, wallet TEXT NOT NULL,
  PRIMARY KEY (launch_id, phase, wallet)
);
`);

export class LaunchError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// --- config ---

const FACTORY = (process.env.LAUNCH_FACTORY ?? "").toLowerCase() as Hex | "";
// Chains with the factory deployed (same address everywhere via CREATE2).
const LAUNCH_CHAINS = (process.env.LAUNCH_CHAINS ?? "").split(",").map((s) => s.trim()).filter((c) => c && isTradableChain(c));
const PINATA_JWT = process.env.PINATA_JWT ?? "";
// PINATA_GATEWAY may be a bare host ("x.mypinata.cloud") or a full URL.
const GATEWAY = (() => {
  const g = (process.env.PINATA_GATEWAY ?? "").trim().replace(/\/+$/, "");
  if (!g) return "https://ipfs.io/ipfs/";
  const url = /^https?:\/\//.test(g) ? g : `https://${g}`;
  return /\/ipfs$/.test(url) ? `${url}/` : `${url}/ipfs/`;
})();
// Checksummed form viem accepts, whatever case the client sent.
const addr = (a: string) => getAddress(a.toLowerCase()) as Hex;
export const MAX_ITEMS = 10_000;
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
const MEMBERS = keccak256(toBytes("floorfeed.members")); // FloorFeedDrop.MEMBERS
const passKey = process.env.LAUNCH_PASS_KEY?.trim();
const passAccount = passKey && /^0x[0-9a-fA-F]{64}$/.test(passKey) ? privateKeyToAccount(passKey as Hex) : null;

export function launchConfig() {
  return {
    enabled: !!FACTORY && LAUNCH_CHAINS.length > 0,
    uploads: !!PINATA_JWT,
    chains: LAUNCH_CHAINS.map((c) => ({ id: c, name: (EVM_CHAINS as Record<string, { name: string }>)[c]?.name ?? c, native: (EVM_CHAINS as Record<string, { native: string }>)[c]?.native ?? "ETH" })),
    factory: FACTORY || null,
    maxItems: MAX_ITEMS,
    gateway: GATEWAY,
  };
}

// --- drafts ---

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PhaseIn = z.object({
  name: z.string().trim().min(1).max(40),
  start: z.number().int().min(0),
  end: z.number().int().min(0), // 0 = until sold out
  price: z.string().regex(/^\d+(\.\d{1,18})?$/), // native coin, decimal
  maxPerWallet: z.number().int().min(0).max(1000),
  allowlist: z.boolean(),
  members: z.boolean().optional(), // FloorFeed accounts only (mintWithPass); wins over allowlist
});
export type PhaseIn = z.infer<typeof PhaseIn>;

const DraftIn = z.object({
  chain: z.string().refine((c) => LAUNCH_CHAINS.includes(c), "FloorFeed can't launch on that network yet."),
  name: z.string().trim().min(1).max(60),
  symbol: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9]+$/, "Symbol: letters and numbers only."),
  description: z.string().max(2000).default(""),
  website: z.string().url().max(200).nullable().optional(),
  twitter: z.string().max(40).regex(/^[A-Za-z0-9_]*$/).nullable().optional(),
  royaltyBps: z.number().int().min(0).max(1000), // up to 10%
  royaltyTo: z.string().regex(ADDRESS).nullable().optional(),
  storage: z.enum(["ipfs", "onchain"]),
  reveal: z.enum(["instant", "later"]),
  coverCid: z.string().max(120).nullable().optional(),
  bannerCid: z.string().max(120).nullable().optional(),
  placeholderCid: z.string().max(120).nullable().optional(),
  phases: z.array(PhaseIn).min(1).max(8),
});
export type DraftIn = z.infer<typeof DraftIn>;

type Row = {
  id: string; user_id: string; creator: string | null; chain: string; name: string; symbol: string; description: string;
  website: string | null; twitter: string | null; royalty_bps: number; royalty_to: string | null; storage: string;
  cover_cid: string | null; banner_cid: string | null; placeholder_cid: string | null; phases: string; reveal: string;
  meta_cid: string | null; contract_uri: string | null; placeholder_uri: string | null; provenance: string | null;
  address: string | null; deploy_tx: string | null; status: string; created_at: number; updated_at: number;
};

const getRow = (id: string) => db.prepare(`SELECT * FROM launches WHERE id = ?`).get(id) as Row | undefined;
function owned(id: string, userId: string) {
  const r = getRow(id);
  if (!r || r.user_id !== userId) throw new LaunchError("Not found.", 404);
  return r;
}
const itemCount = (id: string) => (db.prepare(`SELECT COUNT(*) AS n FROM launch_items WHERE launch_id = ?`).get(id) as { n: number }).n;
const allowCounts = (id: string) => Object.fromEntries((db.prepare(`SELECT phase, COUNT(*) AS n FROM launch_allow WHERE launch_id = ? GROUP BY phase`).all(id) as { phase: number; n: number }[]).map((r) => [r.phase, r.n]));

function view(r: Row) {
  return {
    id: r.id, chain: r.chain, name: r.name, symbol: r.symbol, description: r.description, website: r.website, twitter: r.twitter,
    royaltyBps: r.royalty_bps, royaltyTo: r.royalty_to, storage: r.storage, reveal: r.reveal,
    coverCid: r.cover_cid, bannerCid: r.banner_cid, placeholderCid: r.placeholder_cid,
    phases: JSON.parse(r.phases) as PhaseIn[], allowlists: allowCounts(r.id), items: itemCount(r.id),
    metaCid: r.meta_cid, contractUri: r.contract_uri, creator: r.creator, address: r.address, deployTx: r.deploy_tx, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export type LaunchView = ReturnType<typeof view>;

// A members phase is never also an allowlist.
const parseDraft = (raw: unknown) => {
  const b = DraftIn.parse(raw);
  b.phases = b.phases.map((p) => (p.members ? { ...p, allowlist: false } : { ...p, members: undefined }));
  return b;
};

export function createDraft(userId: string, raw: unknown) {
  const b = parseDraft(raw);
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO launches (id, user_id, chain, name, symbol, description, website, twitter, royalty_bps, royalty_to, storage, reveal,
      cover_cid, banner_cid, placeholder_cid, phases, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, b.chain, b.name, b.symbol.toUpperCase(), b.description, b.website ?? null, b.twitter ?? null, b.royaltyBps,
      b.royaltyTo?.toLowerCase() ?? null, b.storage, b.reveal, b.coverCid ?? null, b.bannerCid ?? null, b.placeholderCid ?? null,
      JSON.stringify(b.phases), now, now);
  return view(getRow(id)!);
}

export function updateDraft(id: string, userId: string, raw: unknown) {
  const r = owned(id, userId);
  if (r.status !== "draft") throw new LaunchError("This collection is already launched; change it from its manage page.");
  const b = parseDraft(raw);
  db.prepare(`UPDATE launches SET chain=?, name=?, symbol=?, description=?, website=?, twitter=?, royalty_bps=?, royalty_to=?, storage=?, reveal=?,
      cover_cid=?, banner_cid=?, placeholder_cid=?, phases=?, meta_cid=NULL, contract_uri=NULL, placeholder_uri=NULL, updated_at=? WHERE id=?`)
    .run(b.chain, b.name, b.symbol.toUpperCase(), b.description, b.website ?? null, b.twitter ?? null, b.royaltyBps, b.royaltyTo?.toLowerCase() ?? null,
      b.storage, b.reveal, b.coverCid ?? null, b.bannerCid ?? null, b.placeholderCid ?? null, JSON.stringify(b.phases), Date.now(), id);
  // Phases that no longer exist (or stopped being allowlists) drop their lists.
  db.prepare(`DELETE FROM launch_allow WHERE launch_id = ? AND phase >= ?`).run(id, b.phases.length);
  b.phases.forEach((p, i) => { if (!p.allowlist) db.prepare(`DELETE FROM launch_allow WHERE launch_id = ? AND phase = ?`).run(id, i); });
  return view(getRow(id)!);
}

export const getDraft = (id: string, userId: string) => view(owned(id, userId));
export const myLaunches = (userId: string) =>
  (db.prepare(`SELECT * FROM launches WHERE user_id = ? AND status != 'hidden' ORDER BY updated_at DESC LIMIT 50`).all(userId) as Row[]).map(view);

export function deleteDraft(id: string, userId: string) {
  const r = owned(id, userId);
  if (r.status !== "draft") throw new LaunchError("A launched collection can't be deleted.");
  db.transaction(() => {
    db.prepare(`DELETE FROM launch_items WHERE launch_id = ?`).run(id);
    db.prepare(`DELETE FROM launch_allow WHERE launch_id = ?`).run(id);
    db.prepare(`DELETE FROM launches WHERE id = ?`).run(id);
  })();
  return { ok: true };
}

// --- art and traits ---

const ItemIn = z.object({
  idx: z.number().int().min(1).max(MAX_ITEMS),
  cid: z.string().min(10).max(120).regex(/^[A-Za-z0-9]+$/),
  mime: z.string().max(60).optional(),
  name: z.string().max(100).optional(),
  attributes: z.array(z.object({ trait_type: z.string().max(60), value: z.union([z.string().max(100), z.number()]) })).max(50).optional(),
});

/** Add or replace artworks (1-based index). The creator's browser uploaded the files to IPFS. */
export function putItems(id: string, userId: string, raw: unknown) {
  const r = owned(id, userId);
  if (r.status !== "draft") throw new LaunchError("The art is locked once the collection is launched.");
  const items = z.array(ItemIn).max(500).parse(raw);
  const put = db.prepare(`INSERT OR REPLACE INTO launch_items (launch_id, idx, cid, mime, name, attributes) VALUES (?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const it of items) put.run(id, it.idx, it.cid, it.mime ?? null, it.name ?? null, it.attributes ? JSON.stringify(it.attributes) : null);
    db.prepare(`UPDATE launches SET meta_cid = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), id);
  })();
  return { items: itemCount(id) };
}

/** Keep only artworks 1..n (after the creator removes files). */
export function trimItems(id: string, userId: string, n: number) {
  owned(id, userId);
  db.prepare(`DELETE FROM launch_items WHERE launch_id = ? AND idx > ?`).run(id, n);
  return { items: itemCount(id) };
}

export function listItems(id: string, userId: string, offset: number, limit: number) {
  owned(id, userId);
  return (db.prepare(`SELECT idx, cid, mime, name, attributes FROM launch_items WHERE launch_id = ? ORDER BY idx LIMIT ? OFFSET ?`)
    .all(id, limit, offset) as { idx: number; cid: string; mime: string | null; name: string | null; attributes: string | null }[])
    .map((x) => ({ ...x, attributes: x.attributes ? JSON.parse(x.attributes) : [] }));
}

// --- allowlists ---

export function setAllowlist(id: string, userId: string, phase: number, wallets: string[]) {
  const r = owned(id, userId);
  if (r.status !== "draft") throw new LaunchError("Allowlists are fixed once launched.");
  const phases = JSON.parse(r.phases) as PhaseIn[];
  if (!phases[phase]?.allowlist) throw new LaunchError("That phase isn't an allowlist phase.");
  const clean = [...new Set(wallets.map((w) => w.trim().toLowerCase()).filter((w) => ADDRESS.test(w)))];
  if (clean.length > 20_000) throw new LaunchError("Allowlists are limited to 20,000 wallets.");
  db.transaction(() => {
    db.prepare(`DELETE FROM launch_allow WHERE launch_id = ? AND phase = ?`).run(id, phase);
    const put = db.prepare(`INSERT INTO launch_allow (launch_id, phase, wallet) VALUES (?, ?, ?)`);
    for (const w of clean) put.run(id, phase, w);
  })();
  return { phase, wallets: clean.length, skipped: wallets.length - clean.length };
}

const walletsOf = (id: string, phase: number) =>
  (db.prepare(`SELECT wallet FROM launch_allow WHERE launch_id = ? AND phase = ? ORDER BY wallet`).all(id, phase) as { wallet: string }[]).map((r) => r.wallet);

// Merkle tree matching the contract: leaf = keccak256(bytes.concat(keccak256(abi.encode(wallet)))),
// pairs hashed sorted (OpenZeppelin MerkleProof), an odd node carried up as is.
const leafOf = (w: string) => keccak256(keccak256(encodeAbiParameters([{ type: "address" }], [w as Hex])));
const pair = (a: Hex, b: Hex) => keccak256((a.toLowerCase() < b.toLowerCase() ? a + b.slice(2) : b + a.slice(2)) as Hex);
export function merkle(wallets: string[]) {
  const leaves = [...new Set(wallets.map((w) => w.toLowerCase()))].map(leafOf).sort();
  if (!leaves.length) return { root: ("0x" + "00".repeat(32)) as Hex, proof: () => [] as Hex[] };
  const layers: Hex[][] = [leaves as Hex[]];
  while (layers.at(-1)!.length > 1) {
    const prev = layers.at(-1)!;
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? pair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  return {
    root: layers.at(-1)![0],
    proof(wallet: string): Hex[] | null {
      let i = layers[0].indexOf(leafOf(wallet.toLowerCase()));
      if (i < 0) return null;
      const out: Hex[] = [];
      for (const layer of layers.slice(0, -1)) {
        const sib = i % 2 ? i - 1 : i + 1;
        if (sib < layer.length) out.push(layer[sib]);
        i = Math.floor(i / 2);
      }
      return out;
    },
  };
}

// --- IPFS (Pinata) ---

function needPinata() {
  if (!PINATA_JWT) throw new LaunchError("Uploads aren't set up on this server yet.", 503);
}

/** Signed one-off upload URLs so the creator's browser sends files straight to Pinata. */
export async function signUploads(id: string, userId: string, count: number, kind: "art" | "image") {
  owned(id, userId);
  needPinata();
  const n = Math.min(Math.max(1, count), 50);
  const one = async () => {
    const res = await fetch("https://uploads.pinata.cloud/v3/files/sign", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${PINATA_JWT}` },
      body: JSON.stringify({
        network: "public", expires: 900, date: Math.floor(Date.now() / 1000),
        max_file_size: kind === "art" ? 15_000_000 : 8_000_000,
        allow_mime_types: ["image/*", ...(kind === "art" ? ["video/mp4", "model/gltf-binary"] : [])],
      }),
    });
    if (!res.ok) throw new LaunchError(`Upload service error (${res.status}).`, 502);
    return ((await res.json()) as { data: string }).data;
  };
  const urls: string[] = [];
  for (let i = 0; i < n; i += 10) urls.push(...(await Promise.all(Array.from({ length: Math.min(10, n - i) }, one))));
  return { urls };
}

async function pinFolder(name: string, files: { path: string; body: string }[]) {
  needPinata();
  const form = new FormData();
  for (const f of files) form.append("file", new Blob([f.body], { type: "application/json" }), `${name}/${f.path}`);
  form.append("pinataMetadata", JSON.stringify({ name }));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: { authorization: `Bearer ${PINATA_JWT}` }, body: form });
  if (!res.ok) throw new LaunchError(`Couldn't pin metadata (${res.status}): ${(await res.text()).slice(0, 120)}`, 502);
  return ((await res.json()) as { IpfsHash: string }).IpfsHash;
}

/** Build and pin token metadata (1.json..N.json), the collection metadata and the placeholder. */
export async function buildMetadata(id: string, userId: string) {
  const r = owned(id, userId);
  if (r.status !== "draft") throw new LaunchError("Already launched.");
  const items = db.prepare(`SELECT idx, cid, mime, name, attributes FROM launch_items WHERE launch_id = ? ORDER BY idx`).all(id) as
    { idx: number; cid: string; mime: string | null; name: string | null; attributes: string | null }[];
  if (!items.length) throw new LaunchError("Upload the artwork first.");
  if (items.some((it, i) => it.idx !== i + 1)) throw new LaunchError("Artwork numbers have gaps; re-upload the set.");
  // The reveal shuffles which artwork each token shows (artworkOf), so artwork #12 can land on
  // token #5: a number in the metadata name would contradict the token id. Numbered names
  // ("Cool Cat #12", as generators write them) are dropped and marketplaces show the token id;
  // unnumbered 1/1 titles describe the artwork and are kept.
  const title = (n: string | null) => (n && !/#\s*\d+\s*$/.test(n) ? n.trim() : undefined);
  const tokens = items.map((it) => ({
    path: `${it.idx}.json`,
    body: JSON.stringify({
      ...(title(it.name) ? { name: title(it.name) } : {}),
      description: r.description,
      image: `ipfs://${it.cid}`,
      ...(it.mime?.startsWith("video/") || it.mime?.startsWith("model/") ? { animation_url: `ipfs://${it.cid}` } : {}),
      attributes: it.attributes ? JSON.parse(it.attributes) : [],
    }),
  }));
  // Provenance: hash of every artwork CID in order, published before mint.
  const provenance = keccak256(new TextEncoder().encode(items.map((i) => i.cid).join(",")));
  const metaCid = await pinFolder(`${r.symbol}-meta-${id.slice(0, 8)}`, tokens);
  const extra = await pinFolder(`${r.symbol}-collection-${id.slice(0, 8)}`, [
    {
      path: "collection.json",
      body: JSON.stringify({
        name: r.name, description: r.description,
        image: r.cover_cid ? `ipfs://${r.cover_cid}` : `ipfs://${items[0].cid}`,
        ...(r.banner_cid ? { banner_image: `ipfs://${r.banner_cid}` } : {}),
        ...(r.website ? { external_link: r.website } : {}),
        seller_fee_basis_points: r.royalty_bps,
        fee_recipient: r.royalty_to ?? undefined,
      }),
    },
    {
      path: "hidden.json",
      body: JSON.stringify({
        name: `${r.name} (unrevealed)`, description: `${r.description}\n\nRevealed after the mint.`.trim(),
        image: r.placeholder_cid ? `ipfs://${r.placeholder_cid}` : r.cover_cid ? `ipfs://${r.cover_cid}` : `ipfs://${items[0].cid}`,
      }),
    },
  ]);
  db.prepare(`UPDATE launches SET meta_cid = ?, contract_uri = ?, placeholder_uri = ?, provenance = ?, updated_at = ? WHERE id = ?`)
    .run(metaCid, `ipfs://${extra}/collection.json`, `ipfs://${extra}/hidden.json`, provenance, Date.now(), id);
  return view(getRow(id)!);
}

// --- deploy ---

const salt = (id: string) => keccak256(new TextEncoder().encode(`floorfeed:${id}`));
const chainId = (c: string) => (EVM_CHAINS as Record<string, { id: number }>)[c].id;
const explorer = (c: string) => (EVM_CHAINS as Record<string, { explorer: string }>)[c].explorer;

function initArgs(r: Row, creator: string) {
  const phases = JSON.parse(r.phases) as PhaseIn[];
  const count = itemCount(r.id);
  return {
    name: r.name, symbol: r.symbol, contractURI: r.contract_uri!, owner: addr(creator),
    royaltyReceiver: addr(r.royalty_to ?? creator), royaltyBps: BigInt(r.royalty_bps), maxSupply: count,
    placeholderURI: r.placeholder_uri!, provenance: (r.provenance ?? "0x" + "00".repeat(32)) as Hex,
    phases: phases.map((p, i) => ({
      start: BigInt(p.start), end: BigInt(p.end), price: parseEther(p.price), maxPerWallet: p.maxPerWallet,
      merkleRoot: p.members ? MEMBERS : p.allowlist ? merkle(walletsOf(r.id, i)).root : ZERO32,
    })),
  };
}

function checkReady(r: Row) {
  const phases = JSON.parse(r.phases) as PhaseIn[];
  const problems: string[] = [];
  if (!itemCount(r.id)) problems.push("Upload the artwork.");
  if (r.storage === "onchain") problems.push("On-chain storage is coming soon; choose IPFS for now.");
  if (!r.meta_cid) problems.push("Prepare the metadata (the last step pins it to IPFS).");
  phases.forEach((p, i) => {
    if (p.allowlist && !walletsOf(r.id, i).length) problems.push(`Phase "${p.name}" is an allowlist with no wallets.`);
    if (p.end && p.end <= p.start) problems.push(`Phase "${p.name}" ends before it starts.`);
  });
  return problems;
}

/** The creator's deploy transaction (FloorFeedFactory.createCollection), simulated first. */
export async function deployTx(id: string, userId: string, creator: string) {
  const r = owned(id, userId);
  if (!FACTORY) throw new LaunchError("Launching isn't switched on yet.", 503);
  if (r.status !== "draft") throw new LaunchError("Already launched.");
  if (!ADDRESS.test(creator)) throw new LaunchError("Connect the wallet that will own the collection.");
  const problems = checkReady(r);
  if (problems.length) throw new LaunchError(problems.join(" "));
  const c = evmPublicClient(r.chain);
  if ((JSON.parse(r.phases) as PhaseIn[]).some((p) => p.members)) {
    // Members phases need a factory whose pass signer is this server's key.
    const signer = await c.readContract({ address: FACTORY, abi: factoryAbi, functionName: "passSigner" }).catch(() => null) as string | null;
    if (!passAccount || !signer || signer.toLowerCase() !== passAccount.address.toLowerCase())
      throw new LaunchError("FloorFeed members phases aren't switched on for this network yet.");
  }
  const init = initArgs(r, creator.toLowerCase());
  const data = encodeFunctionData({ abi: factoryAbi, functionName: "createCollection", args: [salt(id), init] });
  const predicted = (await c.readContract({ address: FACTORY, abi: factoryAbi, functionName: "predictAddress", args: [addr(creator), salt(id)] })) as Hex;
  if ((await c.getCode({ address: predicted }))?.length) throw new LaunchError("This draft was already launched from that wallet.");
  const fee = (await c.readContract({ address: FACTORY, abi: factoryAbi, functionName: "feeOf", args: [addr(creator)] })) as bigint;
  let gas: bigint;
  try {
    gas = await simulateEvm(r.chain, { from: addr(creator), to: FACTORY, data, value: 0n });
  } catch (err) {
    throw new LaunchError(/insufficient funds/i.test((err as Error).message)
      ? `Not enough ${(EVM_CHAINS as Record<string, { native: string }>)[r.chain].native} on ${r.chain} for gas.` : `The launch would fail: ${(err as Error).message.slice(0, 160)}`);
  }
  db.prepare(`UPDATE launches SET creator = ?, updated_at = ? WHERE id = ?`).run(creator.toLowerCase(), Date.now(), id);
  return {
    chainId: chainId(r.chain), explorerTx: `${explorer(r.chain)}/tx/`, to: FACTORY, data, value: "0",
    gas: ((gas * 12n) / 10n).toString(), predicted: predicted.toLowerCase(), mintFee: Number(formatEther(fee)),
  };
}

/** After the creator's wallet sends the deploy: check the receipt and mark the draft launched. */
export async function confirmDeploy(id: string, userId: string, hash: string) {
  const r = owned(id, userId);
  if (r.status !== "draft") return view(r);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash) || !r.creator) throw new LaunchError("Bad transaction.");
  const c = evmPublicClient(r.chain);
  const receipt = await c.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
  if (!receipt) throw new LaunchError("Not confirmed yet.", 409);
  if (receipt.status !== "success") throw new LaunchError("The launch transaction failed on chain.");
  const created = parseEventLogs({ abi: factoryAbi, eventName: "CollectionCreated", logs: receipt.logs })
    .find((l) => l.address.toLowerCase() === FACTORY && (l.args as { creator: string }).creator.toLowerCase() === r.creator);
  if (!created) throw new LaunchError("That transaction didn't launch this collection.");
  const address = (created.args as { collection: string }).collection.toLowerCase();
  db.prepare(`UPDATE launches SET address = ?, deploy_tx = ?, status = 'live', updated_at = ? WHERE id = ?`).run(address, hash, Date.now(), id);
  return view(getRow(id)!);
}

// Contract error name from a failed simulation ("custom error 0x5426a580" → "WalletLimit").
// The drop's custom error behind a failed simulation, else the message. Nodes report reverts
// differently ("custom error 0x…", or only raw revert data on the error's cause), so try both.
function errorName(err: unknown) {
  const m = (err as Error).message ?? String(err);
  const decode = (data: string) => {
    try { return decodeErrorResult({ abi: dropAbi, data: (data.length < 10 + 64 * 4 ? data.padEnd(10 + 64 * 4, "0") : data) as Hex }).errorName; } catch { return null; }
  };
  for (let e = err as { data?: unknown; cause?: unknown } | undefined, i = 0; e && i < 8; e = e.cause as typeof e, i++) {
    const d = typeof e.data === "string" ? e.data : (e.data as { data?: unknown } | undefined)?.data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8}/.test(d)) { const n = decode(d); if (n) return n; }
  }
  const sel = /custom error (0x[0-9a-fA-F]{8})/.exec(m)?.[1] ?? /signature:?\s*(0x[0-9a-fA-F]{8})/.exec(m)?.[1];
  return (sel && decode(sel)) || m;
}

// --- public: launched collections ---

// The collection image: its cover, else artwork #1, the same fallback collection.json uses (so it
// matches OpenSea's collection image).
const firstArt = db.prepare(`SELECT cid FROM launch_items WHERE launch_id = ? ORDER BY idx LIMIT 1`);
const coverOf = (r: Row) => {
  const cid = r.cover_cid ?? (firstArt.get(r.id) as { cid: string } | undefined)?.cid;
  return cid ? `${GATEWAY}${cid}` : null;
};

const byAddress = (chain: string, address: string) =>
  db.prepare(`SELECT * FROM launches WHERE chain = ? AND address = ? AND status = 'live'`).get(chain, address.toLowerCase()) as Row | undefined;

/** A launched collection for its public mint page, with on-chain state. */
export async function launchedCollection(chain: string, address: string, wallet?: string, userId?: string) {
  const r = byAddress(chain, address);
  if (!r) throw new LaunchError("Not found.", 404);
  const c = evmPublicClient(chain);
  const a = address as Hex;
  const read = <T,>(functionName: string, args: unknown[] = []) =>
    c.readContract({ address: a, abi: dropAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
  const [minted, max, fee, revealed, phases, owner] = await Promise.all([
    read<number>("totalMinted"), read<number>("maxSupply"), read<bigint>("mintFee"), read<boolean>("revealed"),
    read<{ start: bigint; end: bigint; price: bigint; maxPerWallet: number; merkleRoot: Hex }[]>("phases"), read<string>("owner"),
  ]);
  const names = JSON.parse(r.phases) as PhaseIn[];
  const now = Math.floor(Date.now() / 1000);
  const w = wallet && ADDRESS.test(wallet) ? wallet.toLowerCase() : null;
  const out = await Promise.all(phases.map(async (p, i) => {
    const start = Number(p.start), end = Number(p.end);
    const members = p.merkleRoot === MEMBERS;
    const allowlist = !members && p.merkleRoot !== ZERO32;
    // Members: any signed-in FloorFeed account (the server checks again when it signs the pass).
    const eligible = members ? (userId ? userId.startsWith("did:privy:") : null) : w && allowlist ? merkle(walletsOf(r.id, i)).proof(w) != null : null;
    const mintedByWallet = w ? Number(await read<bigint>("mintedInPhase", [BigInt(i), addr(w)])) : null;
    const mintedByAccount = members && userId ? Number(await read<bigint>("mintedByAccount", [BigInt(i), accountHash(userId)])) : null;
    return {
      index: i, name: names[i]?.name ?? `Phase ${i + 1}`, start, end, price: Number(formatEther(p.price)), maxPerWallet: p.maxPerWallet,
      allowlist, allowlistSize: allowlist ? walletsOf(r.id, i).length : null, members, eligible, mintedByWallet, mintedByAccount,
      active: now >= start && (end === 0 || now < end),
    };
  }));
  const balance = w ? Number(formatEther(await c.getBalance({ address: addr(w) }))) : null;
  return {
    id: r.id, chain, chainName: (EVM_CHAINS as Record<string, { name: string }>)[chain]?.name ?? chain,
    native: (EVM_CHAINS as Record<string, { native: string }>)[chain]?.native ?? "ETH",
    address: address.toLowerCase(), name: r.name, symbol: r.symbol, description: r.description, website: r.website, twitter: r.twitter,
    image: coverOf(r), banner: r.banner_cid ? `${GATEWAY}${r.banner_cid}` : null,
    creator: owner.toLowerCase(), minted: Number(minted), max: Number(max), soldOut: Number(minted) >= Number(max),
    mintFee: Number(formatEther(fee)), revealed, phases: out, royaltyBps: r.royalty_bps, balance,
    explorer: explorer(chain),
  };
}

/** A mint for `minter` in `phase` (proof included for allowlists), simulated first. */
const accountHash = (userId: string) => keccak256(toBytes(userId));

/** A member pass for `minter` in `phase`, good for 10 minutes; the phase's per-wallet limit is also the per-account limit. */
async function memberPass(chain: string, address: Hex, minter: string, phase: number, maxPerAccount: number, userId: string) {
  if (!passAccount) throw new LaunchError("FloorFeed members minting isn't switched on.", 503);
  const pass = { account: accountHash(userId), maxPerAccount, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
  const signature = await passAccount.signTypedData({
    domain: { name: "FloorFeedDrop", version: "1", chainId: chainId(chain), verifyingContract: address },
    types: { Pass: [{ name: "to", type: "address" }, { name: "phase", type: "uint256" }, { name: "account", type: "bytes32" },
      { name: "maxPerAccount", type: "uint32" }, { name: "deadline", type: "uint64" }] },
    primaryType: "Pass",
    message: { to: addr(minter), phase: BigInt(phase), ...pass },
  });
  return { pass, signature };
}

/** `userId` must already be verified as the signed-in account (routes/launch.ts); members phases need it. */
export async function launchMintTx(chain: string, address: string, b: { minter: string; phase: number; quantity: number; userId?: string }) {
  const r = byAddress(chain, address);
  if (!r) throw new LaunchError("Not found.", 404);
  if (!ADDRESS.test(b.minter)) throw new LaunchError("Connect a wallet to mint.");
  const c = evmPublicClient(chain);
  const a = address as Hex;
  const phases = (await c.readContract({ address: a, abi: dropAbi, functionName: "phases" })) as readonly { merkleRoot: Hex; maxPerWallet: number }[];
  const ph = phases[b.phase];
  if (!ph) throw new LaunchError("No such phase.");
  let proof: Hex[] = [];
  let data: Hex | undefined;
  if (ph.merkleRoot === MEMBERS) {
    if (!b.userId?.startsWith("did:privy:")) throw new LaunchError("This phase is for FloorFeed members. Sign in to mint.", 401);
    const { pass, signature } = await memberPass(chain, a, b.minter, b.phase, ph.maxPerWallet, b.userId);
    data = encodeFunctionData({ abi: dropAbi, functionName: "mintWithPass", args: [addr(b.minter), BigInt(b.phase), BigInt(b.quantity), pass, signature] });
  } else if (ph.merkleRoot !== ZERO32) {
    const tree = merkle(walletsOf(r.id, b.phase));
    if (tree.root !== ph.merkleRoot) throw new LaunchError("The allowlist on FloorFeed doesn't match the contract.");
    const p = tree.proof(b.minter);
    if (!p) throw new LaunchError("This wallet isn't on the list for this phase.");
    proof = p;
  }
  data ??= encodeFunctionData({ abi: dropAbi, functionName: "mint", args: [addr(b.minter), BigInt(b.phase), BigInt(b.quantity), proof] });
  const value = (await c.readContract({ address: a, abi: dropAbi, functionName: "mintCost", args: [BigInt(b.phase), BigInt(b.quantity)] })) as bigint;
  let gas: bigint;
  try {
    gas = await simulateEvm(chain, { from: addr(b.minter), to: address, data, value });
  } catch (err) {
    const m = errorName(err);
    const native = (EVM_CHAINS as Record<string, { native: string }>)[chain].native;
    throw new LaunchError(/insufficient funds/i.test(m) ? `Not enough ${native} for the mint plus gas.`
      : /PhaseNotActive/.test(m) ? "This phase isn't open right now."
      : /SoldOut/.test(m) ? "Sold out (or not enough left for that many)."
      : /WalletLimit/.test(m) ? "That's more than this wallet can mint in this phase."
      : /NotAllowlisted/.test(m) ? "This wallet isn't on the list for this phase."
      : /AccountLimit/.test(m) ? "Your FloorFeed account has already minted its limit in this phase."
      : /BadPass|PassExpired/.test(m) ? "FloorFeed couldn't confirm your membership for this mint. Try again."
      : (console.warn("[launch] mint sim:", m.slice(0, 300)), "The mint would fail right now."));
  }
  return {
    chainId: chainId(chain), explorerTx: `${explorer(chain)}/tx/`, to: address.toLowerCase(), data, value: value.toString(),
    gas: ((gas * 12n) / 10n).toString(), total: Number(formatEther(value)), unit: (EVM_CHAINS as Record<string, { native: string }>)[chain].native,
  };
}

// --- creator: manage a launched collection (owner-signed transactions) ---

export async function manageTx(id: string, userId: string, b: { action: "reveal" | "withdraw" | "freeze"; to?: string }) {
  const r = owned(id, userId);
  if (r.status !== "live" || !r.address) throw new LaunchError("Not launched yet.");
  const data = b.action === "reveal"
    ? encodeFunctionData({ abi: dropAbi, functionName: "reveal", args: [`ipfs://${r.meta_cid}/`] })
    : b.action === "freeze"
      ? encodeFunctionData({ abi: dropAbi, functionName: "freezeMetadata" })
      : encodeFunctionData({ abi: dropAbi, functionName: "withdraw", args: [addr(b.to ?? r.creator!)] });
  const owner = (await evmPublicClient(r.chain).readContract({ address: r.address as Hex, abi: dropAbi, functionName: "owner" })) as string;
  const gas = await simulateEvm(r.chain, { from: owner, to: r.address, data, value: 0n }).catch((err: Error) => {
    throw new LaunchError(/AlreadyRevealed/.test(err.message) ? "Already revealed." : /NotRevealed/.test(err.message) ? "Reveal first." : `That would fail: ${err.message.slice(0, 120)}`);
  });
  return { chainId: chainId(r.chain), explorerTx: `${explorer(r.chain)}/tx/`, to: r.address, data, value: "0", gas: ((gas * 12n) / 10n).toString(), owner: owner.toLowerCase() };
}

/** For the Mint hub: launched collections with their on-chain progress. */
export function liveLaunches() {
  return db.prepare(`SELECT * FROM launches WHERE status = 'live' ORDER BY updated_at DESC LIMIT 100`).all() as Row[];
}

// Launched collections as Mint-hub drops (cached a minute): current or next phase from the contract.
let hubCache: { at: number; v: (Drop & { launched: true })[] } | null = null;
export async function hubLaunches() {
  if (hubCache && Date.now() - hubCache.at < 60_000) return hubCache.v;
  const now = Math.floor(Date.now() / 1000);
  const rows = liveLaunches();
  const v = (await Promise.all(rows.map(async (r) => {
    try {
      const c = evmPublicClient(r.chain);
      const a = r.address as Hex;
      const [minted, max, phases] = await Promise.all([
        c.readContract({ address: a, abi: dropAbi, functionName: "totalMinted" }) as Promise<number>,
        c.readContract({ address: a, abi: dropAbi, functionName: "maxSupply" }) as Promise<number>,
        c.readContract({ address: a, abi: dropAbi, functionName: "phases" }) as Promise<readonly { start: bigint; end: bigint; price: bigint }[]>,
      ]);
      const names = JSON.parse(r.phases) as PhaseIn[];
      const list = phases.map((p, i) => ({ i, start: Number(p.start), end: Number(p.end), price: Number(formatEther(p.price)) }));
      const active = list.find((p) => now >= p.start && (p.end === 0 || now < p.end));
      const next = list.filter((p) => p.start > now).sort((x, y) => x.start - y.start)[0];
      const ph = active ?? next ?? list[list.length - 1];
      const native = (EVM_CHAINS as Record<string, { native: string }>)[r.chain]?.native ?? "ETH";
      return {
        slug: `ff:${r.chain}:${r.address}`, name: r.name, chain: r.chain, contract: r.address, launched: true as const,
        image: coverOf(r), url: `/c/${r.chain}/${r.address}`,
        minting: !!active && Number(minted) < Number(max), featured: false, stage: names[ph.i]?.name ?? null,
        price: ph.price, currency: native, priceUsd: ph.price ? (usdPrice(native) ?? 0) * ph.price || null : null,
        startsAt: ph.start, endsAt: active?.end || null,
      };
    } catch { return null; }
  }))).filter((x) => x != null);
  hubCache = { at: Date.now(), v };
  return v;
}

// --- one launched NFT (item page) ---

const launchByContract = db.prepare(`SELECT * FROM launches WHERE address = ? AND status = 'live'`);
const itemAttrs = db.prepare(`SELECT attributes FROM launch_items WHERE launch_id = ?`);
const tokenCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof loadLaunchedToken>> }>();

const toHttp = (uri: string) => (uri.startsWith("ipfs://") ? `${GATEWAY}${uri.slice(7)}` : uri);

async function loadLaunchedToken(r: Row, tokenId: bigint) {
  const c = evmPublicClient(r.chain);
  const a = r.address as Hex;
  const [uri, owner] = await Promise.all([
    c.readContract({ address: a, abi: dropAbi, functionName: "tokenURI", args: [tokenId] }) as Promise<string>,
    c.readContract({ address: a, abi: dropAbi, functionName: "ownerOf", args: [tokenId] }) as Promise<string>,
  ]);
  // Read the metadata the contract points at right now (so a reveal shows at once, no marketplace cache).
  let meta: { name?: string; image?: string; attributes?: { trait_type?: string; value?: unknown }[] } = {};
  if (uri.startsWith("data:application/json;base64,")) meta = JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf8"));
  else {
    const res = await fetch(toHttp(uri), { signal: AbortSignal.timeout(8000) });
    if (res.ok) meta = await res.json();
  }
  return {
    name: typeof meta.name === "string" ? meta.name : null,
    image: typeof meta.image === "string" ? toHttp(meta.image) : null,
    attrs: (Array.isArray(meta.attributes) ? meta.attributes : [])
      .filter((t) => t && t.trait_type != null && t.value != null)
      .map((t) => ({ type: String(t.trait_type), value: String(t.value) })),
    owner: owner.toLowerCase(),
  };
}

/** Item-page data for an NFT from a live launchpad collection, or null if `id` (contract:tokenId) isn't one. */
export async function launchedItem(id: string) {
  const [contract, token] = id.toLowerCase().split(":");
  if (!contract || !/^\d+$/.test(token ?? "")) return null;
  const r = launchByContract.get(contract) as Row | undefined;
  if (!r) return null;
  const hit = tokenCache.get(id);
  const t = hit && Date.now() - hit.at < 30_000 ? hit.data : await loadLaunchedToken(r, BigInt(token));
  tokenCache.set(id, { at: Date.now(), data: t });
  if (tokenCache.size > 2000) tokenCache.clear();
  // Trait shares from the uploaded set (the whole supply), so they're right from the first mint.
  const counts: Record<string, Record<string, number>> = {};
  const rows = itemAttrs.all(r.id) as { attributes: string | null }[];
  for (const row of rows) for (const a of (row.attributes ? JSON.parse(row.attributes) : []) as { trait_type: string; value: unknown }[]) {
    (counts[a.trait_type] ??= {})[String(a.value)] = (counts[a.trait_type]?.[String(a.value)] ?? 0) + 1;
  }
  const chainName = r.chain;
  return {
    chain: r.chain, currency: (EVM_CHAINS as Record<string, { native: string }>)[chainName]?.native ?? "ETH",
    collection: { name: r.name, floor: null, image: coverOf(r) },
    name: t.name, image: t.image, owner: t.owner, attrs: t.attrs, total: rows.length, counts,
    drop: { chain: r.chain, address: contract },
    marketUrl: `https://opensea.io/assets/${osChain(r.chain)}/${contract}/${token}`,
    explorerUrl: `${explorer(r.chain)}/token/${contract}/instance/${token}`,
  };
}
