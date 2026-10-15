import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc, createTransactionMessage, fetchAddressesForLookupTables, getBase64EncodedWireTransaction, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Instruction,
} from "@solana/kit";
import { formatEther, formatUnits, parseUnits } from "viem";
import { ADDRESS_RE, rpc, solBalance } from "./chain.ts";
import { EVM_CHAINS, config } from "./config.ts";
import { EVM_ADDRESS_RE, evmBalances, evmChainOf, evmGasReserve, evmTxState, simulateEvm } from "./trade-evm.ts";

// Moving funds between chains without leaving FloorFeed, via Relay
// (https://relay.link): Relay quotes a route, the user's wallet signs one
// deposit transaction on the origin chain, and Relay's solvers pay out on the
// destination, usually within seconds. Native token in, native token out, so
// ETH on Ethereum -> ETH on Ink, ETH -> APE on ApeChain, or SOL -> ETH on Base.
// FloorFeed never holds the funds; it only relays the quote and simulates the
// deposit. Solana deposits come from Relay as instructions, so FloorFeed
// assembles the (unsigned) transaction and the Solana wallet signs and sends it.

const RELAY = "https://api.relay.link";
const NATIVE = "0x0000000000000000000000000000000000000000";
const SOL_NATIVE = "11111111111111111111111111111111";
const SOLANA_ID = 792703809; // Relay's id for Solana
// FloorFeed's own fee on bridges (Relay "app fee", basis points of the input,
// shown in the sheet). Relay credits it to an off-chain USDC balance for this
// EVM address; the owner claims it with a signature (Relay app or /app-fees API).
const APP_FEE_RECIPIENT = process.env.RELAY_FEE_RECIPIENT ?? "";
const APP_FEE_BPS = Number(process.env.RELAY_FEE_BPS ?? 0);
const appFees = /^0x[0-9a-fA-F]{40}$/.test(APP_FEE_RECIPIENT) && APP_FEE_BPS > 0 && APP_FEE_BPS <= 100
  ? [{ recipient: APP_FEE_RECIPIENT, fee: String(Math.round(APP_FEE_BPS)) }] : undefined;
const SOL_FEE_RESERVE = 0.00002; // base fee + a priority fee the wallet may add
const SOL_RENT_MIN = 0.00089088;   // rent-exempt minimum for a plain wallet account
type Chain = keyof typeof EVM_CHAINS | "solana";
const isEvm = (c: string): c is keyof typeof EVM_CHAINS => c in EVM_CHAINS && !!evmChainOf(EVM_CHAINS[c as keyof typeof EVM_CHAINS].id);
const info = (c: Chain) => c === "solana"
  ? { id: SOLANA_ID, name: "Solana", native: "SOL", decimals: 9, currency: SOL_NATIVE, explorerTx: "https://solscan.io/tx/" }
  : { id: EVM_CHAINS[c].id, name: EVM_CHAINS[c].name, native: EVM_CHAINS[c].native, decimals: 18, currency: NATIVE, explorerTx: `${EVM_CHAINS[c].explorer}/tx/` };

type EvmItem = { from: string; to: string; data: string; value: string; chainId: number; gas?: string };
type SolItem = {
  instructions: { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[];
  addressLookupTableAddresses?: string[];
};
type RelayQuote = {
  steps?: { id: string; kind: string; requestId?: string; items: { data: EvmItem | SolItem }[] }[];
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

const solRpc = createSolanaRpc(config.solanaRpcUrl);
const hexBytes = (h: string) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((b) => parseInt(b, 16)));

// Relay's Solana deposit -> an unsigned v0 transaction (base64) with a fresh
// blockhash. The user's wallet must be the only signer, and it pays the fee.
async function buildSolDeposit(user: string, item: SolItem) {
  const signers = new Set(item.instructions.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey)));
  if (signers.size !== 1 || !signers.has(user)) throw new Error("Relay returned an unexpected route. Try again.");
  const ixs: Instruction[] = item.instructions.map((i) => ({
    programAddress: address(i.programId),
    accounts: i.keys.map((k) => ({
      address: address(k.pubkey),
      role: k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: hexBytes(i.data),
  }));
  const [{ value: lifetime }, tables] = await Promise.all([
    solRpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
    item.addressLookupTableAddresses?.length ? fetchAddressesForLookupTables(item.addressLookupTableAddresses.map(address), solRpc) : {},
  ]);
  const message = compressTransactionMessageUsingAddressLookupTables(pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(user), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  ), tables);
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

// Dry run without a signature: null when it would land, else the reason.
async function simulateSol(tx: string) {
  const r = await rpc<{ value: { err: unknown; logs?: string[] } }>("simulateTransaction", [tx, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }]);
  if (!r.value.err) return null;
  const logs = (r.value.logs ?? []).join(" ");
  return /insufficient lamports|insufficient funds/i.test(logs) || JSON.stringify(r.value.err).includes("InsufficientFunds") ? "funds" : "fail";
}

// Did a Solana deposit reach the chain? Same states as evmTxState.
export async function solTxState(sig: string) {
  const r = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
  const st = r.value[0];
  if (!st) return "missing" as const;
  if (st.err) return "failed" as const;
  return st.confirmationStatus === "processed" ? "pending" as const : "mined" as const;
}
// Its outcome and fee payer (the wallet that sent it), for the activity log.
export async function solTxInfo(sig: string) {
  const tx = await rpc<{ meta: { err: unknown } | null; transaction: { message: { accountKeys: (string | { pubkey: string })[] } } } | null>(
    "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null);
  if (tx) {
    const k = tx.transaction.message.accountKeys[0];
    return { state: tx.meta?.err ? "failed" as const : "mined" as const, from: typeof k === "string" ? k : k.pubkey };
  }
  const state = await solTxState(sig);
  return { state: state === "mined" ? "pending" as const : state, from: null }; // confirmed but not yet indexed
}

// `amount` is what should ARRIVE on the destination (exact output), in its native
// token. `user` sends on the origin chain; `recipient` receives on the
// destination (the same address between EVM chains; a Solana route needs the
// user's wallet on the other side).
// `side` says what `amount` is: "receive" (default) = what should arrive, in
// the destination's token; "send" = what leaves the origin, in its token.
// `fraction` (0-1] sends that share of the origin balance instead, keeping
// back the network fee, so 1 is "Max".
export async function bridgeQuote(p: {
  user: string; recipient?: string; from: string; to: string;
  amount?: number; side?: "send" | "receive"; fraction?: number;
}) {
  const from = p.from as Chain, to = p.to as Chain;
  if ((from !== "solana" && !isEvm(from)) || (to !== "solana" && !isEvm(to))) throw new Error("That route isn't supported.");
  if (from === to) throw new Error("Pick two different networks.");
  let side = p.side ?? "receive";
  let amount = p.amount ?? 0;
  let reserve: number | null = null;
  if (p.fraction != null) {
    if (!(p.fraction > 0 && p.fraction <= 1)) throw new Error("Pick a share of your balance.");
    const bal = from === "solana"
      ? await solBalance(p.user).then((b) => b.sol)
      : await evmBalances(p.user).then((b) => (b as Record<string, number>)[from] ?? 0);
    // Solana: an account that isn't emptied must keep the rent-exempt minimum, and it can't be
    // emptied exactly while it also pays the fee, so Max keeps that minimum plus the fee.
    reserve = from === "solana" ? SOL_RENT_MIN + SOL_FEE_RESERVE * 2 : await evmGasReserve(from);
    amount = Math.min(bal * p.fraction, bal - reserve);
    side = "send";
    if (!(amount > 0)) throw new Error(`Not enough ${info(from).native} on ${info(from).name} to cover the network fee.`);
  }
  if (!(amount > 0) || amount > 1e9) throw new Error("Enter an amount.");
  const recipient = p.recipient ?? p.user;
  const okAddr = (c: Chain, a: string) => (c === "solana" ? ADDRESS_RE.test(a) : EVM_ADDRESS_RE.test(a));
  if (!okAddr(from, p.user)) throw new Error(from === "solana" ? "Connect a Solana wallet to send from Solana." : "Connect an Ethereum wallet first.");
  if (!okAddr(to, recipient)) throw new Error(to === "solana" ? "Connect a Solana wallet to receive on Solana." : "Connect an Ethereum wallet to receive the funds.");
  const src = info(from), dst = info(to);
  const q = await relay<RelayQuote>("/quote", {
    user: p.user, recipient,
    originChainId: src.id, destinationChainId: dst.id,
    originCurrency: src.currency, destinationCurrency: dst.currency,
    ...(side === "send"
      ? { amount: parseUnits(amount.toFixed(src.decimals), src.decimals).toString(), tradeType: "EXACT_INPUT" }
      : { amount: parseUnits(amount.toFixed(dst.decimals), dst.decimals).toString(), tradeType: "EXACT_OUTPUT" }),
    ...(appFees ? { appFees } : {}),
  }).catch((err: Error) => {
    throw new Error(/amount|small|minimum/i.test(err.message) ? `Relay can't move that amount: ${err.message}` : `No route right now: ${err.message}`);
  });
  // Native in means one deposit transaction; anything else (approvals, signatures) isn't expected.
  const steps = q.steps ?? [];
  const raw = steps.length === 1 && steps[0].kind === "transaction" && steps[0].items.length === 1 ? steps[0].items[0].data : null;
  if (!raw) throw new Error("Relay returned an unexpected route. Try again.");
  const send = Number(formatUnits(BigInt(q.details?.currencyIn?.amount ?? "0"), src.decimals));
  const receive = Number(formatUnits(BigInt(q.details?.currencyOut?.amount ?? "0"), dst.decimals));
  let problem: string | null = null;
  const short = (bal: number) => `You have ${bal.toFixed(4)} ${src.native} on ${src.name}; this needs ${send.toFixed(4)} plus the network fee.`;
  const failMsg = (why: "funds" | "fail") => why === "funds"
    ? `Not enough ${src.native} on ${src.name} for this amount plus the network fee.`
    : "The bridge deposit would fail right now. Try a different amount.";

  let balance: number | null = null;
  let tx: { chainId: number; to: string; data: string; value: string; gas: string; explorerTx: string } | null = null;
  let solTx: { transaction: string; explorerTx: string } | null = null;
  if (from === "solana") {
    balance = await solBalance(p.user).then((b) => b.sol).catch(() => null);
    const item = raw as SolItem;
    if (!Array.isArray(item.instructions)) throw new Error("Relay returned an unexpected route. Try again.");
    if (balance != null && send + SOL_FEE_RESERVE > balance) problem = short(balance);
    else {
      const transaction = await buildSolDeposit(p.user, item);
      const why = await simulateSol(transaction).catch(() => null);
      if (why) problem = failMsg(why);
      else solTx = { transaction, explorerTx: src.explorerTx };
    }
  } else {
    const item = raw as EvmItem;
    if (item.chainId !== src.id || item.from?.toLowerCase() !== p.user.toLowerCase()) throw new Error("Relay returned an unexpected route. Try again.");
    const balances = await evmBalances(p.user).catch(() => null);
    balance = balances ? balances[from as keyof typeof balances] ?? null : null;
    const value = Number(formatEther(BigInt(item.value)));
    // Dry run as the user: a short balance fails here, not in the wallet.
    if (balance != null && value > balance) problem = short(balance);
    else try {
      const gas = await simulateEvm(from, { from: p.user, to: item.to, data: item.data, value: BigInt(item.value) });
      tx = { chainId: item.chainId, to: item.to, data: item.data, value: item.value, gas: ((gas * 12n) / 10n).toString(), explorerTx: src.explorerTx };
    } catch (err) {
      problem = failMsg(/insufficient funds/i.test((err as Error).message) ? "funds" : "fail");
    }
  }
  const usd = (k: string) => Number(q.fees?.[k]?.amountUsd ?? 0);
  return {
    requestId: steps[0].requestId ?? null,
    from, to, recipient, side,
    reserve, // with `fraction`: what was kept back for the network fee, in sendUnit
    send, sendUnit: src.native, sendUsd: Number(q.details?.currencyIn?.amountUsd ?? 0) || null,
    receive, receiveUnit: dst.native,
    feeUsd: usd("relayer") || null, // Relay's fee (solver + destination gas)
    appFeeUsd: usd("app") || null,  // FloorFeed's fee
    appFeePct: appFees ? APP_FEE_BPS / 100 : null,
    gasUsd: usd("gas") || null,     // origin network fee
    seconds: q.details?.timeEstimate ?? null,
    balance,
    problem,
    tx,    // EVM origin: for the EVM wallet
    solTx, // Solana origin: unsigned transaction for the Solana wallet; its blockhash lasts about a minute
  };
}

// waiting -> pending -> success | failure | refund
// With `deposit` (origin chain + tx hash), also reports whether the deposit
// itself reached the chain: a wallet can return a hash for a transaction that
// never gets broadcast, and Relay then just says "waiting" forever.
export async function bridgeStatus(requestId: string, deposit?: { chain: string; tx: string }) {
  const [r, dep] = await Promise.all([
    relay<{ status?: string; txHashes?: string[]; inTxHashes?: string[] }>(`/intents/status/v2?requestId=${encodeURIComponent(requestId)}`),
    deposit ? (deposit.chain === "solana" ? solTxState(deposit.tx) : evmTxState(deposit.chain, deposit.tx)).catch(() => null) : null,
  ]);
  return { status: r.status ?? "unknown", outTx: r.txHashes?.[0] ?? null, deposit: dep };
}
