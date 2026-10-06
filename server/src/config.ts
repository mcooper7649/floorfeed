export const config = {
  port: Number(process.env.PORT ?? 8030),
  dbPath: process.env.DB_PATH ?? "./floorfeed.db",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "nimble:latest",
  heliusWebhookSecret: process.env.HELIUS_WEBHOOK_SECRET ?? "",
  // How often to pull fresh trades / floor prices from Magic Eden.
  activityPollMs: 2 * 60_000,
  statsPollMs: 5 * 60_000,
  // Paper sells fill at floor minus this haircut, a stand-in for the top
  // collection bid until a bids source (Tensor API) is wired in.
  paperSellHaircut: 0.03,
};

// Starter set of liquid Solana collections (verified on Magic Eden 2026-10-06).
export const COLLECTIONS: { symbol: string; name: string }[] = [
  { symbol: "mad_lads", name: "Mad Lads" },
  { symbol: "claynosaurz", name: "Claynosaurz" },
  { symbol: "solana_monkey_business", name: "Solana Monkey Business" },
  { symbol: "famous_fox_federation", name: "Famous Fox Federation" },
  { symbol: "okay_bears", name: "Okay Bears" },
  { symbol: "retardio_cousins", name: "Retardio Cousins" },
  { symbol: "tensorians", name: "Tensorians" },
  { symbol: "sensei", name: "Sensei" },
  { symbol: "froganas", name: "Froganas" },
];

export const collectionName = (symbol: string) =>
  COLLECTIONS.find((c) => c.symbol === symbol)?.name ?? symbol;
