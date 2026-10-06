export const config = {
  port: Number(process.env.PORT ?? 8030),
  dbPath: process.env.DB_PATH ?? "./floorfeed.db",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "nimble:latest",
  heliusWebhookSecret: process.env.HELIUS_WEBHOOK_SECRET ?? "",
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

export type Chain = "solana" | "ethereum" | "base" | "polygon";

// EVM collections, stats-only via OpenSea's keyless API (verified 2026-10-06).
// `slug` doubles as the collection id in URLs; none collide with ME symbols.
export const EVM_COLLECTIONS: { slug: string; name: string; chain: Chain; category: Category }[] = [
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

export const collectionName = (symbol: string) =>
  COLLECTIONS.find((c) => c.symbol === symbol)?.name ?? symbol;
