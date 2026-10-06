import Anthropic from "@anthropic-ai/sdk";
import { collectionName, config } from "./config.ts";
import { db } from "./db.ts";
import type { WalletStats } from "./pnl.ts";

// One-line "AI take" on a trade. Claude when an API key is configured,
// otherwise the local Ollama box, so the demo runs at zero cost.
const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const SYSTEM = `You write one-line context notes for trades in a social NFT trading feed.
Given a trade, the buyer's track record, and collection stats, write ONE sentence (max 28 words)
that helps a reader judge the trade: is the buyer skilled, was the price above or below floor,
is the collection active? Be specific with numbers. Neutral tone, no hype, no emojis,
never tell the reader to buy or sell.`;

export type TakeInput = {
  signature: string;
  collection: string;
  price: number;
  floor: number | null;
  avg24h: number | null;
  volume7d: number | null;
  buyer: WalletStats;
};

function prompt(t: TakeInput) {
  const b = t.buyer;
  return JSON.stringify({
    collection: collectionName(t.collection),
    price_sol: t.price,
    floor_sol: t.floor,
    avg_sale_24h_sol: t.avg24h,
    volume_7d_sol: t.volume7d,
    buyer: {
      tracked_flips: b.flips,
      win_rate: b.winRate,
      realized_pnl_sol: Number(b.realizedSol.toFixed(2)),
      open_positions: b.openPositions,
      buys: b.buys,
    },
  });
}

async function viaClaude(input: string): Promise<string | null> {
  const res = await claude!.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: SYSTEM,
    messages: [{ role: "user", content: input }],
  });
  if (res.stop_reason === "refusal") return null;
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  return text || null;
}

async function viaOllama(input: string): Promise<string | null> {
  const res = await fetch(`${config.ollamaUrl}/api/generate`, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: config.ollamaModel,
      system: SYSTEM,
      prompt: input,
      stream: false,
      think: false,
      options: { temperature: 0.3, num_predict: 120 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const { response } = (await res.json()) as { response: string };
  return response.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || null;
}

const getCached = db.prepare(`SELECT text, model FROM takes WHERE signature = ?`);
const putCached = db.prepare(
  `INSERT OR REPLACE INTO takes (signature, text, model, created_at) VALUES (?, ?, ?, ?)`,
);
const inflight = new Map<string, Promise<{ text: string; model: string } | null>>();

export function cachedTake(signature: string) {
  return getCached.get(signature) as { text: string; model: string } | undefined;
}

export function getTake(t: TakeInput) {
  const hit = cachedTake(t.signature);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(t.signature);
  if (!p) {
    p = (async () => {
      const input = prompt(t);
      const model = claude ? "claude-opus-5-5" : config.ollamaModel;
      const text = claude ? await viaClaude(input) : await viaOllama(input);
      if (!text) return null;
      putCached.run(t.signature, text, model, Date.now());
      return { text, model };
    })().finally(() => inflight.delete(t.signature));
    inflight.set(t.signature, p);
  }
  return p;
}
