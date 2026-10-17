import { db } from "./db.ts";
import { walletActivity } from "./activity.ts";
import { EVM_CHAINS, EVM_SALES, collectionName } from "./config.ts";
import { fromOsChain, getOsAccountEvents, getOsOrder, osChain, type OsAccountEvent } from "./opensea.ts";

// A wallet's full trading history, for the History page and its CSV export:
// FloorFeed's own transactions (activity.ts) merged with the marketplace
// record: OpenSea account events on EVM chains (buys, sales, listings,
// transfers, mints, offers) and ingested Magic Eden trades on Solana. Each
// listing and offer carries its outcome (active, sold / accepted, cancelled,
// expired), which OpenSea's events don't say, so it's looked up per order and
// kept in listing_status (offers too: an order is an order).

db.exec(`
CREATE TABLE IF NOT EXISTS listing_status (
  order_hash TEXT PRIMARY KEY,
  chain      TEXT NOT NULL,
  status     TEXT NOT NULL,      -- active | sold | cancelled | expired | inactive
  closed_at  INTEGER,            -- when it sold / was cancelled, when known
  via_ff     INTEGER NOT NULL DEFAULT 0, -- listed through FloorFeed
  checked_at INTEGER NOT NULL
);
`);

export type HistoryType =
  | "buy" | "sale" | "listing" | "offer" | "mint" | "launch" | "transfer_in" | "transfer_out"
  | "bridge" | "send" | "approve" | "unwrap";
export type HistoryEntry = {
  id: string; at: number; type: HistoryType; status: string; wallet: string; chain: string;
  title: string; name: string; collection: string | null; symbol: string | null;
  mint: string | null; tokenId: string | null; image: string | null;
  price: number | null; unit: string | null;
  counterparty: string | null; // the other side of a sale or transfer
  via: "floorfeed" | "opensea" | "magiceden";
  saleKind: "listing" | "offer" | null;
  tx: string | null; explorerUrl: string | null; marketUrl: string | null;
  toChain: string | null; outUrl: string | null;
  listing: { orderHash: string; listedAt: number; expiresAt: number | null; closedAt: number | null; soldTx: string | null; buyer: string | null } | null;
};

const TERMINAL = new Set(["sold", "cancelled", "expired"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const now = () => Math.floor(Date.now() / 1000);

const getStatus = db.prepare("SELECT * FROM listing_status WHERE order_hash = ?");
const putStatus = db.prepare(`INSERT INTO listing_status (order_hash, chain, status, closed_at, via_ff, checked_at)
  VALUES (@hash, @chain, @status, @closed, @ff, @now)
  ON CONFLICT(order_hash) DO UPDATE SET status = excluded.status,
    closed_at = COALESCE(listing_status.closed_at, excluded.closed_at),
    via_ff = MAX(listing_status.via_ff, excluded.via_ff), checked_at = excluded.checked_at`);
type StatusRow = { order_hash: string; chain: string; status: string; closed_at: number | null; via_ff: number; checked_at: number };

// Hooks from list-evm.ts, so FloorFeed listings are badged and cancels get an exact time.
export const noteListed = (orderHash: string, chain: string) =>
  putStatus.run({ hash: orderHash.toLowerCase(), chain, status: "active", closed: null, ff: 1, now: now() });
export const noteCancelled = (orderHash: string, chain: string) =>
  putStatus.run({ hash: orderHash.toLowerCase(), chain, status: "cancelled", closed: now(), ff: 0, now: now() });

const explorer = (chain: string, hash: string) => chain === "solana"
  ? `https://solscan.io/tx/${hash}`
  : `${EVM_CHAINS[chain as keyof typeof EVM_CHAINS]?.explorer ?? "https://etherscan.io"}/tx/${hash}`;
const osAsset = (chain: string, contract: string, id: string) => `https://opensea.io/assets/${osChain(chain)}/${contract}/${id}`;
const amount = (p?: { quantity: string; decimals: number }) => (p ? Number(p.quantity) / 10 ** p.decimals : null);
const tracked = (slug: string) => EVM_SALES.find((c) => c.slug === slug);
// An untracked collection's OpenSea slug as a readable name: "inkverse-920024436" -> "Inkverse".
const prettySlug = (slug: string) => slug.replace(/-\d{5,}$/, "").split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

// --- EVM: OpenSea events, cached a couple of minutes per wallet ---

const osCache = new Map<string, { at: number; v: Promise<{ events: OsAccountEvent[]; more: boolean }> }>();
function osEvents(wallet: string) {
  const hit = osCache.get(wallet);
  if (hit && Date.now() - hit.at < 120_000) return hit.v;
  const v = getOsAccountEvents(wallet);
  v.catch(() => osCache.delete(wallet));
  if (osCache.size > 500) osCache.clear();
  osCache.set(wallet, { at: Date.now(), v });
  return v;
}

// Orders still open are re-read at most every 10 min, a few per request
// (each is one OpenSea call through the shared queue). `soldAt`: when the
// order was filled (a listing sold, an offer accepted), if a sale shows it.
async function listingStatus(e: OsAccountEvent, soldAt: number | null, budget: { n: number }): Promise<StatusRow> {
  const hash = e.order_hash!.toLowerCase();
  const chain = fromOsChain(e.chain);
  const row = getStatus.get(hash) as StatusRow | undefined;
  const save = (status: string, closed: number | null) => {
    putStatus.run({ hash, chain, status, closed, ff: 0, now: now() });
    return { ...(row ?? { order_hash: hash, chain, via_ff: 0 }), status, closed_at: row?.closed_at ?? closed, checked_at: now() } as StatusRow;
  };
  if (soldAt != null) return row?.status === "sold" ? row : save("sold", soldAt);
  if (row && TERMINAL.has(row.status)) return row;
  if (e.expiration_date && e.expiration_date < now()) return save("expired", e.expiration_date);
  if (row && now() - row.checked_at < 600) return row;
  if (budget.n-- <= 0) return row ?? { order_hash: hash, chain, status: "active", closed_at: null, via_ff: 0, checked_at: 0 };
  const o = await getOsOrder(chain, hash, true).catch(() => null);
  const s = (o?.status ?? "").toUpperCase();
  return save(s === "FULFILLED" ? "sold" : s === "CANCELLED" ? "cancelled" : s === "EXPIRED" ? "expired"
    : s === "ACTIVE" ? "active" : o ? "inactive" : row?.status ?? "active", null);
}

async function evmHistory(wallet: string) {
  const { events, more } = await osEvents(wallet);
  const me = wallet.toLowerCase();
  const sales = events.filter((e) => e.event_type === "sale");
  const soldByOrder = new Map(sales.filter((e) => e.seller?.toLowerCase() === me && e.order_hash).map((e) => [e.order_hash!.toLowerCase(), e]));
  const myListingHashes = new Set(events.filter((e) => e.order_type === "listing" && e.order_hash).map((e) => e.order_hash!.toLowerCase()));
  // My offers that were accepted show up as sales where I'm the buyer, under the offer's order hash.
  const boughtByOrder = new Map(sales.filter((e) => e.buyer?.toLowerCase() === me && e.order_hash).map((e) => [e.order_hash!.toLowerCase(), e]));
  const saleTx = new Set(sales.map((e) => `${e.transaction}:${e.nft?.contract}:${e.nft?.identifier}`));
  const budget = { n: 20 };

  const out: HistoryEntry[] = [];
  for (const e of events) {
    if (/offer$/.test(e.order_type ?? "") && e.order_hash && e.maker?.toLowerCase() === me) {
      out.push(await offerEntry(e, me, boughtByOrder.get(e.order_hash.toLowerCase()) ?? null, budget));
      continue;
    }
    const nft = e.nft ?? e.asset;
    if (!nft) continue;
    const chain = fromOsChain(e.chain);
    const contract = nft.contract.toLowerCase();
    const meta = tracked(nft.collection);
    const base = {
      wallet: me, chain, name: nft.name ?? `${meta?.name ?? prettySlug(nft.collection)} #${nft.identifier}`,
      collection: meta?.name ?? prettySlug(nft.collection), symbol: meta?.slug ?? null,
      mint: `${contract}:${nft.identifier}`, tokenId: nft.identifier, image: nft.display_image_url ?? nft.image_url ?? null,
      via: "opensea" as const, marketUrl: osAsset(chain, contract, nft.identifier), toChain: null, outUrl: null,
    };
    if (e.event_type === "sale") {
      const buying = e.buyer?.toLowerCase() === me;
      const fromMyListing = !buying && !!e.order_hash && myListingHashes.has(e.order_hash.toLowerCase());
      const offer = /^(WETH|BETH)$/i.test(e.payment?.symbol ?? "");
      out.push({
        ...base, id: `sale:${e.transaction}:${base.mint}`, at: e.event_timestamp, type: buying ? "buy" : "sale", status: "confirmed",
        title: `${buying ? "Bought" : "Sold"} ${base.name}`, price: amount(e.payment), unit: e.payment?.symbol ?? null,
        counterparty: (buying ? e.seller : e.buyer)?.toLowerCase() ?? null,
        saleKind: fromMyListing ? "listing" : offer ? "offer" : buying ? "listing" : null,
        tx: e.transaction ?? null, explorerUrl: e.transaction ? explorer(chain, e.transaction) : null, listing: null,
      });
    } else if (e.order_type === "listing" && e.order_hash) {
      const sold = soldByOrder.get(e.order_hash.toLowerCase());
      const st = await listingStatus(e, sold?.event_timestamp ?? null, budget);
      out.push({
        ...base, id: `listing:${e.order_hash.toLowerCase()}`, at: e.start_date ?? e.event_timestamp, type: "listing", status: st.status,
        title: `Listed ${base.name}`, price: amount(e.payment), unit: e.payment?.symbol ?? null,
        counterparty: sold?.buyer?.toLowerCase() ?? null, saleKind: null,
        via: st.via_ff ? "floorfeed" : "opensea",
        tx: null, explorerUrl: sold?.transaction ? explorer(chain, sold.transaction) : null,
        listing: {
          orderHash: e.order_hash.toLowerCase(), listedAt: e.start_date ?? e.event_timestamp, expiresAt: e.expiration_date ?? null,
          closedAt: sold?.event_timestamp ?? st.closed_at ?? (st.status === "expired" ? e.expiration_date ?? null : null),
          soldTx: sold?.transaction ?? null, buyer: sold?.buyer?.toLowerCase() ?? null,
        },
      });
    } else if (e.event_type === "transfer" || e.event_type === "mint") {
      // A sale's transfer is the sale itself.
      if (saleTx.has(`${e.transaction}:${nft.contract}:${nft.identifier}`)) continue;
      const from = e.from_address?.toLowerCase(), to = e.to_address?.toLowerCase();
      const minted = e.event_type === "mint" || e.transfer_type === "mint" || from === ZERO;
      const incoming = to === me;
      const type: HistoryType = minted ? "mint" : incoming ? "transfer_in" : "transfer_out";
      out.push({
        ...base, id: `xfer:${e.transaction}:${base.mint}`, at: e.event_timestamp, type, status: "confirmed",
        title: minted ? `Minted ${base.name}` : incoming ? `Received ${base.name}` : `Sent ${base.name}`,
        price: null, unit: null, counterparty: minted ? null : (incoming ? from : to) ?? null, saleKind: null,
        tx: e.transaction ?? null, explorerUrl: e.transaction ? explorer(chain, e.transaction) : null, listing: null,
      });
    }
  }
  return { entries: out, more };
}

// One offer this wallet made: on an NFT, a whole collection, or a trait.
// Its outcome is the order's (accepted when a sale filled it).
const collImage = db.prepare("SELECT image FROM collections WHERE symbol = ?");
async function offerEntry(e: OsAccountEvent, me: string, bought: OsAccountEvent | null, budget: { n: number }): Promise<HistoryEntry> {
  const chain = fromOsChain(e.chain);
  const nft = e.nft ?? e.asset ?? null;
  const slug = e.criteria?.collection?.slug ?? nft?.collection ?? null;
  const meta = slug ? tracked(slug) : undefined;
  const coll = meta?.name ?? (slug ? prettySlug(slug) : null);
  const st = await listingStatus(e, bought?.event_timestamp ?? null, budget);
  const status = st.status === "sold" ? "accepted" : st.status;
  const got = bought?.nft ?? bought?.asset ?? null; // the NFT a collection offer bought
  const item = nft ?? got;
  const kind = nft ? "item" : e.criteria?.traits?.length ? "trait" : "collection";
  const name = nft ? nft.name ?? `${coll ?? "NFT"} #${nft.identifier}` : kind === "trait" ? `${coll ?? "Collection"} trait offer` : `Any ${coll ?? "NFT"}`;
  const qty = Math.max(1, e.quantity ?? 1);
  const total = amount(e.payment);
  const hash = e.order_hash!.toLowerCase();
  return {
    id: `offer:${hash}`, at: e.start_date ?? e.event_timestamp, type: "offer", status, wallet: me, chain,
    title: `Offered on ${name}`, name, collection: coll, symbol: meta?.slug ?? null,
    mint: item ? `${item.contract.toLowerCase()}:${item.identifier}` : null, tokenId: item?.identifier ?? null,
    image: item?.display_image_url ?? item?.image_url ?? (meta ? (collImage.get(meta.slug) as { image: string | null } | undefined)?.image ?? null : null),
    price: total != null ? total / qty : null, unit: e.payment?.symbol ?? null,
    counterparty: bought?.seller?.toLowerCase() ?? null, via: st.via_ff ? "floorfeed" : "opensea", saleKind: null,
    tx: null, explorerUrl: bought?.transaction ? explorer(chain, bought.transaction) : null,
    marketUrl: item ? osAsset(chain, item.contract.toLowerCase(), item.identifier) : `https://opensea.io/collection/${slug ?? ""}`,
    toChain: null, outUrl: null,
    listing: {
      orderHash: hash, listedAt: e.start_date ?? e.event_timestamp, expiresAt: e.expiration_date ?? null,
      closedAt: bought?.event_timestamp ?? st.closed_at ?? (st.status === "expired" ? e.expiration_date ?? null : null),
      soldTx: bought?.transaction ?? null, buyer: bought?.seller?.toLowerCase() ?? null,
    },
  };
}

// --- Solana: ingested marketplace trades (tracked collections) ---

let solTrades: ReturnType<typeof db.prepare> | null = null;
function solanaHistory(wallet: string): HistoryEntry[] {
  solTrades ??= db.prepare(`SELECT signature, collection, mint, buyer, seller, price, block_time, image, source
    FROM trades WHERE buyer = @w OR seller = @w ORDER BY block_time DESC LIMIT 400`);
  const rows = solTrades.all({ w: wallet }) as { signature: string; collection: string; mint: string; buyer: string; seller: string; price: number; block_time: number; image: string | null; source: string | null }[];
  return rows.map((r) => {
    const buying = r.buyer === wallet;
    const name = `${collectionName(r.collection)} ${r.mint.slice(0, 4)}…${r.mint.slice(-4)}`;
    const pool = /^(mmm|tensorswap|tcomp|tensortrade)$/.test(r.source ?? "");
    return {
      id: `sale:${r.signature}:${r.mint}`, at: r.block_time, type: buying ? "buy" : "sale", status: "confirmed", wallet, chain: "solana",
      title: `${buying ? "Bought" : "Sold"} ${name}`, name, collection: collectionName(r.collection), symbol: r.collection,
      mint: r.mint, tokenId: r.mint, image: r.image, price: r.price, unit: "SOL",
      counterparty: buying ? r.seller : r.buyer, via: "magiceden", saleKind: pool ? "offer" : "listing",
      tx: r.signature, explorerUrl: explorer("solana", r.signature), marketUrl: `https://magiceden.io/item-details/${r.mint}`,
      toChain: null, outUrl: null, listing: null,
    } satisfies HistoryEntry;
  });
}

// --- FloorFeed's own transactions ---

async function floorfeedHistory(wallet: string): Promise<HistoryEntry[]> {
  const rows = await walletActivity(wallet, 500);
  return rows.map((r) => {
    const launch = r.kind === "mint" && /^Launched /.test(r.title);
    const type: HistoryType = launch ? "launch" : r.kind === "sell" ? "sale" : (r.kind as HistoryType);
    const evm = r.chain !== "solana";
    const [contract, tokenId] = evm && r.mint?.includes(":") ? r.mint.split(":") : [null, r.mint];
    return {
      id: `ff:${r.hash}`, at: r.createdAt, type, status: r.status, wallet: evm ? wallet.toLowerCase() : wallet, chain: r.chain,
      title: r.title, name: r.title.replace(/^(Bought|Sold|Minted|Launched|Approved selling|Sent|Moved|Unwrapped) /, ""),
      collection: r.symbol ? (tracked(r.symbol)?.name ?? collectionName(r.symbol)) : null, symbol: r.symbol, mint: r.mint, tokenId: tokenId ?? null,
      image: null, price: r.amount, unit: r.unit, counterparty: null, via: "floorfeed",
      saleKind: r.kind === "sell" ? "offer" : r.kind === "buy" ? "listing" : null,
      tx: r.hash, explorerUrl: r.explorerUrl,
      marketUrl: evm && contract && tokenId ? osAsset(r.chain, contract, tokenId) : r.mint && !evm ? `https://magiceden.io/item-details/${r.mint}` : null,
      toChain: r.toChain, outUrl: r.outUrl, listing: null,
    } satisfies HistoryEntry;
  });
}

// Everything for these wallets, newest first. The marketplace row wins for
// details (art, counterparty); FloorFeed's row adds its status and "via FloorFeed".
export async function walletHistory(wallets: string[]) {
  let more = false;
  const parts = await Promise.all(wallets.map(async (w) => {
    const evm = w.startsWith("0x");
    const [ff, market] = await Promise.all([
      floorfeedHistory(w),
      evm ? evmHistory(w).catch(() => ({ entries: [] as HistoryEntry[], more: false, failed: true }))
        : Promise.resolve({ entries: solanaHistory(w), more: false }),
    ]);
    if (market.more) more = true;
    const byTx = new Map(market.entries.filter((e) => e.tx).map((e) => [e.tx!.toLowerCase(), e]));
    const merged = [...market.entries];
    for (const f of ff) {
      const m = byTx.get(f.tx!.toLowerCase());
      if (m && (m.type === f.type || (f.type === "mint" && m.type === "mint"))) {
        m.via = "floorfeed";
        if (m.status === "confirmed") m.status = f.status;
        continue;
      }
      // Pull art over from the marketplace record of the same NFT, when there is one.
      if (!f.image && f.mint) f.image = market.entries.find((e) => e.mint === f.mint && e.image)?.image ?? null;
      merged.push(f);
    }
    return { entries: merged, failed: "failed" in market };
  }));
  const entries = parts.flatMap((p) => p.entries).sort((a, b) => b.at - a.at);
  return { entries, more, partial: parts.some((p) => p.failed) };
}

// --- CSV export ---

const TYPE_LABEL: Record<HistoryType, string> = {
  buy: "Buy", sale: "Sale", listing: "Listing", offer: "Offer", mint: "Mint", launch: "Collection launch", transfer_in: "Transfer in",
  transfer_out: "Transfer out", bridge: "Bridge", send: "Send", approve: "Approval", unwrap: "Unwrap",
};
const iso = (t: number | null | undefined) => (t ? new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) : "");
const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Quote when needed; a leading = + - @ is neutralised so spreadsheets don't run it as a formula.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function historyCsv(entries: HistoryEntry[]) {
  const head = ["Date (UTC)", "Type", "Status", "Collection", "Item", "Token ID", "Network", "Price", "Currency", "Sale type",
    "Counterparty", "Listed (UTC)", "Expires (UTC)", "Closed (UTC)", "Order hash", "Transaction", "Explorer", "Marketplace link", "Via", "Wallet"];
  const lines = entries.map((e) => [
    iso(e.at), TYPE_LABEL[e.type], e.status, e.collection, e.name, e.tokenId, e.toChain ? `${e.chain} -> ${e.toChain}` : e.chain,
    e.price != null ? +e.price.toPrecision(12) : "", e.unit, e.saleKind ?? "", e.counterparty,
    iso(e.listing?.listedAt), iso(e.listing?.expiresAt), iso(e.listing?.closedAt), e.listing?.orderHash,
    e.tx ?? e.listing?.soldTx, e.explorerUrl, e.marketUrl,
    e.via === "floorfeed" ? "FloorFeed" : e.via === "opensea" ? "OpenSea" : "Magic Eden", e.wallet,
  ].map(cell).join(","));
  return "﻿" + [head.join(","), ...lines].join("\r\n") + "\r\n";
}
