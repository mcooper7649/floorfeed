export const config = {
  port: Number(process.env.PORT ?? 8030),
  dbPath: process.env.DB_PATH ?? "./floorfeed.db",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "nimble:latest",
  heliusWebhookSecret: process.env.HELIUS_WEBHOOK_SECRET ?? "",
  heliusApiKey: process.env.HELIUS_API_KEY ?? "",
  // Privy verifies user access tokens server-side; the secret never ships
  // to the app (only the public app ID does).
  privyAppId: process.env.PRIVY_APP_ID ?? "",
  privyAppSecret: process.env.PRIVY_APP_SECRET ?? "",
  // Wallet + trading. The public RPC is fine for balance reads at demo
  // volume; set a Helius (or other) RPC URL for anything heavier.
  solanaRpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  // Buy transactions are built by the marketplaces and need their API keys.
  // Without one, buying stays disabled and the app says so.
  magicEdenApiKey: process.env.MAGICEDEN_API_KEY ?? "",
  tensorApiKey: process.env.TENSOR_API_KEY ?? "",
  // X posting: drafts go to Telegram for approval, then a browser poster on
  // the host publishes them (no paid X API). All optional.
  siteUrl: process.env.SITE_URL ?? "https://floorfeed.io",
  // Where the static web build is served (the SEO renderer reads its index.html).
  webOrigin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:8020",
  webHost: process.env.WEB_HOST ?? "", // Host header for a name-based static server
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  socialToken: process.env.SOCIAL_TOKEN ?? "", // shared secret for the poster
  socialAutoApprove: (process.env.SOCIAL_AUTO_APPROVE ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  socialMinGapMs: 90 * 60_000, // at most one post per 90 minutes
  // How often to pull fresh trades / floor prices from Magic Eden.
  // Sales for the live tier; stats for the whole universe (~40 calls).
  activityPollMs: 3 * 60_000,
  statsPollMs: 10 * 60_000,
  // Paper sells fill at floor minus this haircut, a stand-in for the top
  // collection bid until a bids source (Tensor API) is wired in.
  paperSellHaircut: 0.03,
};

// Browseable market categories (shared by Solana and EVM collections).
export type Category = "PFP" | "Art" | "Gaming" | "Assets" | "Domains" | "Memberships" | "Utility";

// Market universe: established Solana collections with a live floor on Magic
// Eden (verified 2026-10-06), ordered by 7-day volume at that time. The top
// LIVE_TIER_SIZE by current volume get full sales polling; the rest get stats
// polling, with sales fetched on demand when someone opens them.
export const COLLECTIONS: { symbol: string; name: string; category: Category }[] = [
  { symbol: "mad_lads", name: "Mad Lads", category: "PFP" },
  { symbol: "solana_monkey_business", name: "Solana Monkey Business", category: "PFP" },
  { symbol: "claynosaurz", name: "Claynosaurz", category: "PFP" },
  { symbol: "famous_fox_federation", name: "Famous Fox Federation", category: "PFP" },
  { symbol: "retardio_cousins", name: "Retardio Cousins", category: "PFP" },
  { symbol: "degods", name: "DeGods", category: "PFP" },
  { symbol: "taiyo_robotics", name: "Taiyo Robotics", category: "PFP" },
  { symbol: "transdimensional_fox_federation", name: "Transdimensional Fox Federation", category: "PFP" },
  { symbol: "cets_on_creck", name: "Cets on Creck", category: "PFP" },
  { symbol: "y00ts", name: "y00ts", category: "PFP" },
  { symbol: "cyber_frogs", name: "Cyber Frogs", category: "PFP" },
  { symbol: "galactic_geckos", name: "Galactic Geckos", category: "PFP" },
  { symbol: "okay_bears", name: "Okay Bears", category: "PFP" },
  { symbol: "famous_fox_dens", name: "Famous Fox Dens", category: "Utility" },
  { symbol: "smb_gen3", name: "SMB Gen3", category: "PFP" },
  { symbol: "sensei", name: "Sensei", category: "PFP" },
  { symbol: "blocksmith_labs", name: "Blocksmith Labs", category: "Utility" },
  { symbol: "froganas", name: "Froganas", category: "PFP" },
  { symbol: "sharx", name: "Sharx", category: "PFP" },
  { symbol: "aurory", name: "Aurory", category: "Gaming" },
  { symbol: "portals", name: "Portals", category: "Gaming" },
  { symbol: "bodoggos", name: "Bodoggos", category: "PFP" },
  { symbol: "primates", name: "Primates", category: "PFP" },
  { symbol: "boryoku_dragonz", name: "Boryoku Dragonz", category: "Gaming" },
  { symbol: "critters_cult", name: "Critters Cult", category: "Gaming" },
  { symbol: "mindfolk", name: "Mindfolk", category: "PFP" },
  { symbol: "undead_genesis", name: "Undead Genesis", category: "Gaming" },
  { symbol: "abc_abracadabra", name: "ABC", category: "PFP" },
  { symbol: "stoned_ape_crew", name: "Stoned Ape Crew", category: "PFP" },
  { symbol: "tensorians", name: "Tensorians", category: "PFP" },
  { symbol: "trippin_ape_tribe", name: "Trippin' Ape Tribe", category: "PFP" },
  { symbol: "theheist", name: "The Heist", category: "Gaming" },
  { symbol: "shadowy_super_coder_dao", name: "Shadowy Super Coder DAO", category: "Memberships" },
  { symbol: "vandal_city", name: "Vandal City", category: "PFP" },
  { symbol: "liberty_square", name: "Liberty Square", category: "PFP" },
  { symbol: "meekolony", name: "Meekolony", category: "PFP" },
  { symbol: "nyan_heroes", name: "Nyan Heroes", category: "Gaming" },
  { symbol: "gothic_degens", name: "Gothic Degens", category: "PFP" },
  { symbol: "lily", name: "Lily", category: "PFP" },
  // Tokenized graded trading cards (vaulted physical items)
  { symbol: "collector_crypt", name: "Collector Crypt", category: "Assets" },
];

export const LIVE_TIER_SIZE = 20;

export type Chain = "solana" | "ethereum" | "base" | "polygon" | "abstract" | "ink" | "arbitrum" | "hyperevm" | "ronin" | "apechain" | "monad";

// EVM chains FloorFeed tracks.
// - native: the chain's gas token (what a wallet's balance is in).
// - units: currencies its NFTs may be priced in. Each collection uses one,
//   picked from what its sales are actually paid in (Axie on Ronin trades in
//   WETH even though its floor is quoted in RON).
// - discover: how many top collections by 7-day volume to add automatically.
// Polygon's one collection (Courtyard) trades in USDC and is stats-only.
type EvmChainInfo = { name: string; id: number; explorer: string; native: string; units: string[]; discover: number; os?: string };
export const EVM_CHAINS: Record<Exclude<Chain, "solana">, EvmChainInfo> = {
  ethereum: { name: "Ethereum", id: 1, explorer: "https://etherscan.io", native: "ETH", units: ["ETH"], discover: 15 },
  base: { name: "Base", id: 8453, explorer: "https://basescan.org", native: "ETH", units: ["ETH"], discover: 15 },
  abstract: { name: "Abstract", id: 2741, explorer: "https://abscan.org", native: "ETH", units: ["ETH"], discover: 15 },
  ink: { name: "Ink", id: 57073, explorer: "https://explorer.inkonchain.com", native: "ETH", units: ["ETH"], discover: 10 },
  arbitrum: { name: "Arbitrum", id: 42161, explorer: "https://arbiscan.io", native: "ETH", units: ["ETH"], discover: 10 },
  hyperevm: { name: "HyperEVM", id: 999, explorer: "https://hyperevmscan.io", native: "HYPE", units: ["HYPE"], discover: 10 },
  ronin: { name: "Ronin", id: 2020, explorer: "https://app.roninchain.com", native: "RON", units: ["RON", "ETH"], discover: 10 },
  apechain: { name: "ApeChain", id: 33139, explorer: "https://apescan.io", native: "APE", units: ["APE"], discover: 10, os: "ape_chain" },
  monad: { name: "Monad", id: 143, explorer: "https://monadscan.com", native: "MON", units: ["MON"], discover: 10 },
  polygon: { name: "Polygon", id: 137, explorer: "https://polygonscan.com", native: "POL", units: [], discover: 0, os: "matic" },
};

// Currencies FloorFeed keeps profit and loss in. Wrapped tokens count as the
// token (WETH and Blur's BETH as ETH, WHYPE as HYPE...).
export const UNITS = ["SOL", "ETH", "HYPE", "RON", "APE", "MON"] as const;
export type Unit = (typeof UNITS)[number];
// The ecosystem a currency stands for, for labels ("a HyperEVM NFT trader").
export const unitEcosystem = (u: string) =>
  ({ SOL: "Solana", ETH: "Ethereum", HYPE: "HyperEVM", RON: "Ronin", APE: "ApeChain", MON: "Monad" } as Record<string, string>)[u] ?? u;
export function normalizeUnit(symbol: string | null | undefined): Unit | null {
  const s = (symbol ?? "").toUpperCase();
  if (s === "BETH") return "ETH";
  const bare = s.startsWith("W") && (UNITS as readonly string[]).includes(s.slice(1)) ? s.slice(1) : s;
  return (UNITS as readonly string[]).includes(bare) ? (bare as Unit) : null;
}
export const chainName = (c: string) => (c === "solana" ? "Solana" : EVM_CHAINS[c as keyof typeof EVM_CHAINS]?.name ?? c);

// EVM collections via OpenSea: stats for all, plus sales (with OPENSEA_API_KEY)
// for the ones priced in ETH. Prices and P&L stay in each chain's native unit;
// an EVM wallet's numbers are in ETH, a Solana wallet's in SOL.
// `slug` doubles as the collection id in URLs; none collide with ME symbols.
export type EvmCollection = { slug: string; name: string; chain: Chain; category: Category; auto?: boolean };

// Hand-picked EVM collections. discovery.ts appends each chain's current top
// collections (marked `auto`) to this same array at runtime, so everything
// that reads it sees the discovered ones too.
export const EVM_COLLECTIONS: EvmCollection[] = [
  { slug: "cryptopunks", name: "CryptoPunks", chain: "ethereum", category: "PFP" },
  { slug: "pudgypenguins", name: "Pudgy Penguins", chain: "ethereum", category: "PFP" },
  { slug: "boredapeyachtclub", name: "Bored Ape Yacht Club", chain: "ethereum", category: "PFP" },
  { slug: "lilpudgys", name: "Lil Pudgys", chain: "ethereum", category: "PFP" },
  { slug: "azuki", name: "Azuki", chain: "ethereum", category: "PFP" },
  { slug: "milady", name: "Milady Maker", chain: "ethereum", category: "PFP" },
  { slug: "nakamigos", name: "Nakamigos", chain: "ethereum", category: "PFP" },
  { slug: "good-vibes-club", name: "Good Vibes Club", chain: "ethereum", category: "PFP" },
  { slug: "terraforms", name: "Terraforms by Mathcastles", chain: "ethereum", category: "Art" },
  { slug: "doodles-official", name: "Doodles", chain: "ethereum", category: "PFP" },
  { slug: "clonex", name: "CLONE X", chain: "ethereum", category: "PFP" },
  { slug: "meebits", name: "Meebits", chain: "ethereum", category: "PFP" },
  { slug: "ringers-by-dmitri-cherniak", name: "Ringers by Dmitri Cherniak", chain: "ethereum", category: "Art" },
  { slug: "opepen-edition", name: "Opepen Edition", chain: "ethereum", category: "Art" },
  { slug: "remilio-babies", name: "Redacted Remilio Babies", chain: "ethereum", category: "PFP" },
  { slug: "pudgyrods", name: "Pudgy Rods", chain: "ethereum", category: "Memberships" },
  { slug: "mfers", name: "mfers", chain: "ethereum", category: "PFP" },
  { slug: "chromie-squiggle-by-snowfro", name: "Chromie Squiggle by Snowfro", chain: "ethereum", category: "Art" },
  { slug: "cool-cats-nft", name: "Cool Cats", chain: "ethereum", category: "PFP" },
  { slug: "cryptoadz-by-gremplin", name: "CrypToadz by GREMPLIN", chain: "ethereum", category: "PFP" },
  { slug: "sproto-gremlins", name: "Sproto Gremlins", chain: "ethereum", category: "PFP" },
  { slug: "world-of-women-nft", name: "World of Women", chain: "ethereum", category: "PFP" },
  { slug: "kanpai-pandas", name: "Kanpai Pandas", chain: "ethereum", category: "PFP" },
  { slug: "degods-eth", name: "DeGods (Ethereum)", chain: "ethereum", category: "PFP" },
  { slug: "basepaint", name: "BasePaint", chain: "base", category: "Art" },
  { slug: "hv-mtl", name: "HV-MTL", chain: "ethereum", category: "Gaming" },
  { slug: "onchain-gaias", name: "onchain gaias", chain: "base", category: "PFP" },
  { slug: "courtyard-nft", name: "Courtyard.io", chain: "polygon", category: "Assets" },
  { slug: "ens", name: "ENS: Ethereum Name Service", chain: "ethereum", category: "Domains" },
  { slug: "unstoppable-domains", name: "Unstoppable Domains", chain: "ethereum", category: "Domains" },
  { slug: "proof-collective", name: "PROOF Collective", chain: "ethereum", category: "Memberships" },
  { slug: "nouns", name: "Nouns", chain: "ethereum", category: "PFP" },
  { slug: "decentraland", name: "Decentraland", chain: "ethereum", category: "Gaming" },
  { slug: "bored-ape-kennel-club", name: "Bored Ape Kennel Club", chain: "ethereum", category: "PFP" },
];

export const isEvm = (id: string) => EVM_COLLECTIONS.some((c) => c.slug === id);

// Courtyard trades in USDC on Polygon at ~10k sales a day: stats only.
// Kept in place (not reassigned) so importers always see the current list.
export const EVM_SALES: EvmCollection[] = [];
export function syncEvmLists(discovered: EvmCollection[]) {
  const curated = EVM_COLLECTIONS.filter((c) => !c.auto);
  const known = new Set([...curated.map((c) => c.slug), ...COLLECTIONS.map((c) => c.symbol)]);
  EVM_COLLECTIONS.splice(0, EVM_COLLECTIONS.length, ...curated, ...discovered.filter((c) => !known.has(c.slug)));
  EVM_SALES.splice(0, EVM_SALES.length, ...EVM_COLLECTIONS.filter((c) => c.slug !== "courtyard-nft"));
}
syncEvmLists([]);

// Names of collections discovery has seen, including ones it later dropped,
// so their old trades still show a proper name (filled by discovery.ts).
export const knownNames = new Map<string, string>();
export const collectionName = (symbol: string) =>
  COLLECTIONS.find((c) => c.symbol === symbol)?.name ?? EVM_COLLECTIONS.find((c) => c.slug === symbol)?.name
    ?? knownNames.get(symbol) ?? symbol;
export const chainOf = (symbol: string): Chain => EVM_COLLECTIONS.find((c) => c.slug === symbol)?.chain ?? "solana";
export const currencyOf = (symbol: string) => (isEvm(symbol) ? "ETH" : "SOL");
// Wallets are one ecosystem each: 0x addresses are EVM (ETH), the rest Solana.
export const isEvmWallet = (w: string) => w.startsWith("0x");
export const walletUnit = (w: string) => (isEvmWallet(w) ? "ETH" : "SOL");
