import { formatEther, parseEther } from "viem";
import { EVM_CHAINS } from "./config.ts";
import { evmBalances, evmChainOf, simulateEvm } from "./trade-evm.ts";

// Moving funds between chains without leaving FloorFeed, via Relay
// (https://relay.link): Relay quotes a route, the user's wallet signs one
// deposit transaction on the origin chain, and Relay's solvers pay out on the
// destination, usually within seconds. Native token in, native token out, so
// ETH on Ethereum -> ETH on Ink, or ETH -> APE on ApeChain. FloorFeed never
// holds the funds; it only relays the quote and simulates the deposit.

const RELAY = "https://api.relay.link";
const NATIVE = "0x0000000000000000000000000000000000000000";
type Chain = keyof typeof EVM_CHAINS;

type RelayQuote = {
  steps?: { id: string; kind: string; requestId?: string; items: { data: {
    from: string; to: string; data: string; value: string; chainId: number; gas?: string;
  } }[] }[];
  fees?: Record<string, { amountUsd?: string; amountFormatted?: string; currency?: { symbol: string } }>;
  details?: {
    currencyIn?: { amount: string; amountUsd?: string };
    currencyOut?: { amount: string; amountUsd?: string };
    timeEstimate?: number;
    totalImpact?: { usd?: string; percent?: string };
  };
  message?: string;
};

async function relay<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(RELAY + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "FloorFeed/0.1 (+https://floorfeed.io)" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(json.message || `Relay ${res.status}`);
  return json;
}

// `amount` is what should ARRIVE on the destination (exact output), in its native token.
export async function bridgeQuote(p: { user: string; from: string; to: string; amount: number }) {
  const from = p.from as Chain, to = p.to as Chain;
  if (!EVM_CHAINS[from] || !EVM_CHAINS[to] || !evmChainOf(EVM_CHAINS[from].id) || !evmChainOf(EVM_CHAINS[to].id)) {
    throw new Error("That route isn't supported.");
  }
  if (from === to) throw new Error("Pick two different networks.");
  if (!(p.amount > 0) || p.amount > 1e9) throw new Error("Enter an amount.");
  const q = await relay<RelayQuote>("/quote", {
    user: p.user, recipient: p.user,
    originChainId: EVM_CHAINS[from].id, destinationChainId: EVM_CHAINS[to].id,
    originCurrency: NATIVE, destinationCurrency: NATIVE,
    amount: parseEther(p.amount.toFixed(18)).toString(), tradeType: "EXACT_OUTPUT",
  }).catch((err: Error) => {
    throw new Error(/amount|small|minimum/i.test(err.message) ? `Relay can't move that amount: ${err.message}` : `No route right now: ${err.message}`);
  });
  // Native in means one deposit transaction; anything else (approvals, signatures) isn't expected.
  const steps = q.steps ?? [];
  const item = steps.length === 1 && steps[0].kind === "transaction" && steps[0].items.length === 1 ? steps[0].items[0].data : null;
  if (!item || item.chainId !== EVM_CHAINS[from].id || item.from.toLowerCase() !== p.user.toLowerCase()) {
    throw new Error("Relay returned an unexpected route. Try again.");
  }
  const send = Number(formatEther(BigInt(item.value)));
  const balances = await evmBalances(p.user).catch(() => null);
  const balance = balances ? balances[from as keyof typeof balances] ?? null : null;
  // Dry run as the user: a short balance fails here, not in the wallet.
  let gas: bigint | null = null, problem: string | null = null;
  if (balance != null && send > balance) {
    problem = `You have ${balance.toFixed(4)} ${EVM_CHAINS[from].native} on ${EVM_CHAINS[from].name}; this needs ${send.toFixed(4)} plus the network fee.`;
  } else try {
    gas = await simulateEvm(from, { from: p.user, to: item.to, data: item.data, value: BigInt(item.value) });
  } catch (err) {
    problem = /insufficient funds/i.test((err as Error).message)
      ? `Not enough ${EVM_CHAINS[from].native} on ${EVM_CHAINS[from].name} for this amount plus the network fee.`
      : "The bridge deposit would fail right now. Try a different amount.";
  }
  const usd = (k: string) => Number(q.fees?.[k]?.amountUsd ?? 0);
  return {
    requestId: steps[0].requestId ?? null,
    from, to,
    send, sendUnit: EVM_CHAINS[from].native, sendUsd: Number(q.details?.currencyIn?.amountUsd ?? 0) || null,
    receive: Number(formatEther(BigInt(q.details?.currencyOut?.amount ?? "0"))), receiveUnit: EVM_CHAINS[to].native,
    feeUsd: usd("relayer") || null, // Relay's fee (solver + destination gas)
    gasUsd: usd("gas") || null,     // origin network fee
    seconds: q.details?.timeEstimate ?? null,
    balance,
    problem,
    tx: problem ? null : {
      chainId: item.chainId, to: item.to, data: item.data, value: item.value,
      gas: (((gas ?? BigInt(item.gas ?? "100000")) * 12n) / 10n).toString(),
      explorerTx: `${EVM_CHAINS[from].explorer}/tx/`,
    },
  };
}

// waiting -> pending -> success | failure | refund
export async function bridgeStatus(requestId: string) {
  const r = await relay<{ status?: string; txHashes?: string[]; inTxHashes?: string[] }>(
    `/intents/status/v2?requestId=${encodeURIComponent(requestId)}`,
  );
  return { status: r.status ?? "unknown", outTx: r.txHashes?.[0] ?? null };
}
