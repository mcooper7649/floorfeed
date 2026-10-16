import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Instruction,
} from "@solana/kit";
import { rpc } from "./chain.ts";
import { MAX_PRIORITY_LAMPORTS, budgetIx, priorityPrice, solRpc } from "./bridge.ts";

// Sending SOL to any address (a Phantom wallet, a deployer, an exchange) as an
// unsigned v0 transaction for the user's wallet to sign. The fee is worked out
// exactly (base fee + capped priority fee), so "Max" can empty the wallet:
// Solana only allows an account to be empty or above the rent minimum.

const SYSTEM = address("11111111111111111111111111111111");
const RENT_MIN = 890_880n; // lamports a plain account must keep (or be emptied)
const UNITS = 1_000; // a transfer uses ~150 compute units, the two budget instructions ~300
const BASE_FEE = 5_000n;

const transferIx = (from: string, to: string, lamports: bigint): Instruction => {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // SystemInstruction::Transfer
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM,
    accounts: [{ address: address(from), role: AccountRole.WRITABLE_SIGNER }, { address: address(to), role: AccountRole.WRITABLE }],
    data,
  };
};
const fmt = (l: bigint) => (Number(l) / 1e9).toFixed(9).replace(/\.?0+$/, "");

export async function solSendTx(b: { from: string; to: string; amount?: string; max?: boolean }) {
  if (b.from === b.to) throw new Error("That's this wallet's own address.");
  const [{ value: lifetime }, bal, dest] = await Promise.all([
    solRpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
    rpc<{ value: number }>("getBalance", [b.from, { commitment: "confirmed" }]).then((r) => BigInt(r.value)),
    rpc<{ value: { owner: string; executable: boolean } | null }>("getAccountInfo", [b.to, { commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 } }]).then((r) => r.value),
  ]);
  if (dest?.executable) throw new Error("That's a program address, not a wallet. Sending SOL there would lose it.");
  const build = (lamports: bigint, micro: bigint) => getBase64EncodedWireTransaction(compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(b.from), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions([budgetIx(2, BigInt(UNITS), 4), budgetIx(3, micro, 8), transferIx(b.from, b.to, lamports)], m),
  )));
  // Priority price for this transaction, capped so the fee stays under 0.0001 SOL.
  const price = BigInt(await priorityPrice(build(1n, 10_000n)));
  const micro = [price, 10_000n, BigInt(Math.floor((MAX_PRIORITY_LAMPORTS * 1_000_000) / UNITS))].sort((x, y) => (x < y ? -1 : 1))[1];
  const fee = BASE_FEE + (BigInt(UNITS) * micro + 999_999n) / 1_000_000n;

  let lamports: bigint;
  if (b.max) lamports = bal - fee;
  else {
    const [w, f = ""] = (b.amount ?? "").split(".");
    lamports = BigInt(w || "0") * 1_000_000_000n + BigInt((f + "000000000").slice(0, 9) || "0");
  }
  if (lamports <= 0n) throw new Error(b.max ? "Not enough SOL to cover the network fee." : "Enter an amount.");
  const left = bal - lamports - fee;
  if (left < 0n) throw new Error(`You can send up to ${fmt(bal > fee ? bal - fee : 0n)} SOL (the network fee is about ${fmt(fee)} SOL).`);
  if (left > 0n && left < RENT_MIN) throw new Error(`Solana needs at least ${fmt(RENT_MIN)} SOL left in the wallet, or use Max to empty it.`);
  if (!dest && lamports < RENT_MIN) throw new Error(`That address is new on Solana: send at least ${fmt(RENT_MIN)} SOL to it.`);

  const transaction = build(lamports, micro);
  const sim = await rpc<{ value: { err: unknown; logs?: string[] } }>("simulateTransaction", [transaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }]).catch(() => null);
  if (sim?.value.err) throw new Error(`The transfer would fail: ${JSON.stringify(sim.value.err)}`);
  return {
    solTx: { transaction, explorerTx: "https://solscan.io/tx/" },
    amount: Number(lamports) / 1e9, amountExact: fmt(lamports), symbol: "SOL", unit: "SOL", fee: Number(fee) / 1e9, native: "SOL",
  };
}
