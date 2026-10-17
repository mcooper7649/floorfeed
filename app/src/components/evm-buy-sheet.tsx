import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { BridgeSheet } from '@/components/bridge-sheet';
import { DepositSheet } from '@/components/deposit-sheet';
import { EvmOfferSheet } from '@/components/evm-offer-sheet';
import { ModeChip } from '@/components/mode-toggle';
import { NftImage } from '@/components/nft-image';
import { ReportLink } from '@/components/report-link';
import { Stepper, stepLabel } from '@/components/stepper';
import { C } from '@/constants/brand';
import { chainById, chainName } from '@/constants/chains';
import { T } from '@/constants/type';
import { api, type EvmQuote } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useEvmWallet } from '@/lib/evm-wallet';
import { useWallet } from '@/lib/wallet';
import { sol, usd } from '@/lib/format';
import { recordTx } from '@/lib/activity';
import { track } from '@/lib/analytics';
import { usePrices } from '@/lib/prices';

// Real-mode buy on an EVM chain (Ethereum, its L2s, HyperEVM, Ronin, ApeChain, Monad): the cheapest OpenSea listing (or one NFT's
// listing when `id` is given). FloorFeed builds the Seaport transaction and
// simulates it; the user's wallet shows it and asks them to confirm. Nothing
// is sent without that confirmation.

type Step = { kind: 'idle' } | { kind: 'preparing' } | { kind: 'confirm' } | { kind: 'sent'; hash: string; url: string }
  | { kind: 'error'; message: string };

export function EvmBuySheet({ symbol, id, open, onClose, onPaper }: {
  symbol: string;
  id?: string; // contract:tokenId for a specific NFT; otherwise the floor
  open: boolean;
  onClose: () => void;
  onPaper?: () => void;
}) {
  const w = useEvmWallet();
  const sw = useWallet();
  const auth = useAuth();
  const { toUsd } = usePrices();
  const [quote, setQuote] = useState<{ key: string; q: EvmQuote } | { key: string; error: string } | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  useEffect(() => { if (open) track('buy_open', { chain: 'evm' }); }, [open]);
  const [deposit, setDeposit] = useState(false);
  const [bridging, setBridging] = useState<{ to: string; amount?: number; from?: string } | null>(null);
  const [arrived, setArrived] = useState<{ amount: number; unit: string; chain: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [offering, setOffering] = useState(false);
  const key = `${symbol}:${id ?? ''}:${w.address}:${nonce}`;

  useEffect(() => {
    if (!open || !w.address) return;
    let alive = true;
    api.evmQuote(symbol, w.address, id)
      .then((q) => alive && setQuote({ key, q }))
      .catch((e) => alive && setQuote({ key, error: (e as Error).message }));
    return () => { alive = false; };
  }, [open, symbol, id, w.address, key]);

  const current = quote?.key === key ? quote : null;
  const q = current && 'q' in current ? current.q : null;
  const price = q?.listing?.price ?? null;
  // A buy is paid in the chain's gas token (ETH, HYPE, RON, APE, MON).
  const unit = q?.native ?? q?.currency ?? 'ETH';
  const priceUnit = q?.currency ?? unit; // listings show in the collection's currency (Axie: ETH on Ronin)
  const balance = q?.balance ?? q?.balanceEth ?? null;
  // Short = price + gas - balance (executable listings are priced in the gas token).
  const fee = q?.fee ?? null; // FloorFeed's fee, paid in the same transaction
  const total = price != null ? price + (fee?.amount ?? 0) : null;
  const short = total != null && balance != null && q?.executable ? total + (q.gasReserve ?? 0) - balance : null;
  // Bridges take a little while and cheap listings sell fast, so move a cushion
  // (10% of the price) on top: if the cheapest one goes, the next still fits.
  // Whatever is left over stays in the wallet on that chain.
  const bridgeAmount = short != null && price != null ? short + Math.max(price * 0.1, 0.0003) : null;
  const elsewhere = q?.elsewhere ?? [];
  const close = () => { setStep({ kind: 'idle' }); setArrived(null); onClose(); };

  const buy = async () => {
    if (!q?.listing?.orderHash || !q.listing.protocolAddress || !w.address || !w.send) return;
    setStep({ kind: 'preparing' });
    try {
      const tx = await api.evmBuyTx({
        orderHash: q.listing.orderHash, protocolAddress: q.listing.protocolAddress, chain: q.chain, buyer: w.address,
      });
      setStep({ kind: 'confirm' });
      const hash = await w.send({ ...tx, description: tx.feeEth ? `Buy ${q.listing.name ?? q.collection.name}: ${sol(tx.priceEth ?? 0, 4, unit)} + ${sol(tx.feeEth, 5, unit)} FloorFeed fee` : undefined });
      track('buy_signed', { chain: q.chain });
      recordTx({ hash, wallet: w.address, chain: q.chain, kind: 'buy', title: `Bought ${q.listing.name ?? q.collection.name}`,
        amount: tx.valueEth ?? q.listing.price, unit: q.native ?? q.currency ?? 'ETH', symbol: q.collection.symbol, mint: q.listing.mint });
      setStep({ kind: 'sent', hash, url: `${tx.explorerTx ?? `${chainById(tx.chainId)?.[1].explorer ?? 'https://etherscan.io'}/tx/`}${hash}` });
    } catch (e) {
      const msg = (e as Error).message || 'The purchase did not go through.';
      setStep({ kind: 'error', message: /reject|denied|cancel/i.test(msg) ? 'You cancelled in your wallet. Nothing was sent.' : msg });
      setNonce((n) => n + 1); // refresh the quote: the listing may be gone
    }
  };

  // The bridge and deposit sheets sit beside this Modal, not inside it: a hidden
  // Modal unmounts its children on web, which would hide them too.
  return (
    <>
    <Modal visible={open && !deposit && !bridging && !offering} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={s.backdrop} onPress={close}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <View style={s.head}>
            <Text style={s.title}>{id ? 'Buy this NFT' : 'Buy floor'}</Text>
            <ModeChip mode="real" />
          </View>

          {!w.address ? (
            <View style={{ gap: 10 }}>
              <Text style={s.meta}>Buying on Ethereum needs an Ethereum wallet. Sign in for a free FloorFeed wallet, or connect one you have.</Text>
              {auth.supported && !auth.userId && (
                <Pressable accessibilityRole="button" onPress={() => { close(); auth.login(); }} style={s.primary}>
                  <Text style={s.primaryTxt}>Sign in</Text>
                </Pressable>
              )}
              {w.available.map((o) => (
                <Pressable accessibilityRole="button" key={o.name} onPress={() => w.connect(o.name)} style={s.option}>
                  <Image source={{ uri: o.icon }} style={s.icon} />
                  <Text style={s.optionTxt}>{o.name}</Text>
                  <Text style={s.meta}>{w.connecting ? 'Check your wallet…' : 'Connect'}</Text>
                </Pressable>
              ))}
              {auth.userId && !w.available.length && <Text style={s.meta}>Your FloorFeed Ethereum wallet is being set up. Try again in a moment.</Text>}
            </View>
          ) : step.kind === 'sent' ? (
            <View style={{ gap: 10 }}>
              <Text style={s.ok}>✓ Purchase submitted</Text>
              <Text style={s.meta}>It usually confirms within a minute. The NFT then shows up in your Real portfolio, and Activity there shows when it confirms.</Text>
              <Pressable accessibilityRole="link" onPress={() => Linking.openURL(step.url)} style={s.secondary}>
                <Text style={s.secondaryTxt}>View transaction ↗</Text>
              </Pressable>
            </View>
          ) : !current ? (
            <View style={s.loading}>
              <ActivityIndicator color={C.accent} />
              <Text style={s.meta}>Finding the listing…</Text>
            </View>
          ) : !q ? (
            <Text style={s.err}>Couldn&apos;t get a quote: {'error' in current ? current.error : ''}</Text>
          ) : (
            <>
              <View style={s.item}>
                <NftImage uri={q.listing?.image ?? null} name={q.collection.name} ratio={1} radius={12} px={160} style={{ width: 72 }} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.name}>{q.listing?.name ?? q.collection.name}</Text>
                  <Text style={s.meta}>{q.collection.name} · {chainName(q.chain)} · OpenSea listing</Text>
                  <Text style={s.price}>{price != null ? sol(price, 3, priceUnit) : '—'}</Text>
                  {price != null && toUsd(price, priceUnit) != null && <Text style={s.meta}>≈ {usd(toUsd(price, priceUnit)!)}</Text>}
                </View>
              </View>

              <View style={s.rows}>
                <Row label="Listing price" value={price != null ? sol(price, 3, priceUnit) : '—'} />
                {fee && <Row label={`FloorFeed fee (${fee.pct}%)`} value={`${sol(fee.amount, 5, priceUnit)}${toUsd(fee.amount, priceUnit) != null ? ` · ${usd(toUsd(fee.amount, priceUnit)!)}` : ''}`} />}
                <Row label="Network fee" value="shown in your wallet" />
                <Row label="Your wallet" value={balance != null ? `${sol(balance, 3, unit)}${toUsd(balance, unit) != null ? ` · ${usd(toUsd(balance, unit)!)}` : ''}` : '—'} />
                <Row label="Wallet" value={w.walletName ?? '—'} />
              </View>

              {arrived && <Text style={s.okLine}>✓ {sol(arrived.amount, 4, arrived.unit)} arrived on {chainName(arrived.chain)}. Prices are refreshed below.</Text>}
              {q.reason && <Text style={s.meta}>{q.reason}</Text>}
              {step.kind === 'error' && <Text style={s.err}>{step.message}</Text>}
              {step.kind === 'error' && <ReportLink topic="trade" detail={step.message} from="evm-buy" onLeave={onClose} />}

              {/* Short on funds turns a buy into two steps: move money here, then buy. */}
              {q.executable && ((short != null && short > 0) || arrived) && (
                <Stepper current={short != null && short > 0 ? 0 : 1} busy={step.kind === 'preparing' || step.kind === 'confirm'}
                  steps={[
                    { title: `Add ${unit}`, sub: short != null && short > 0 ? `${sol(short, 4, unit)} more on ${chainName(q.chain)}` : 'Arrived' },
                    { title: 'Buy', sub: total != null ? sol(total, 4, unit) : '' },
                  ]} />
              )}
              {short != null && short > 0 ? (
                <>
                  <Text style={s.err}>
                    Not enough {unit} on {chainName(q.chain)}: you have {sol(balance ?? 0, 4, unit)} there and need about {sol(short, 4, unit)} more, including gas.
                  </Text>
                  {elsewhere.length > 0 && (
                    <Text style={s.meta}>
                      Your {unit} is on {elsewhere.map((e) => `${chainName(e.chain)} (${sol(e.balance, 4, unit)})`).join(', ')}.
                      Each network keeps its own balance, so NFTs on {chainName(q.chain)} need {unit} on {chainName(q.chain)}. You can move it here without leaving FloorFeed.
                    </Text>
                  )}
                  {elsewhere.length > 0 && sw.sendTransaction && unit === 'ETH' && (
                    <Pressable accessibilityRole="button" onPress={() => { track('bridge_click', { chain: q.chain, from: 'solana' }); setBridging({ to: q.chain, amount: bridgeAmount ?? undefined, from: 'solana' }); }}>
                      <Text style={[s.meta, { color: C.accent }]}>Or pay with SOL from your Solana wallet</Text>
                    </Pressable>
                  )}
                  {elsewhere.length > 0 ? (
                    <Pressable accessibilityRole="button" onPress={() => { track('bridge_click', { chain: q.chain }); setBridging({ to: q.chain, amount: bridgeAmount ?? undefined }); }} style={s.primary}>
                      <Text style={s.primaryTxt}>Move {unit} to {chainName(q.chain)}</Text>
                    </Pressable>
                  ) : sw.sendTransaction && unit === 'ETH' ? (
                    <Pressable accessibilityRole="button" onPress={() => { track('bridge_click', { chain: q.chain, from: 'solana' }); setBridging({ to: q.chain, amount: bridgeAmount ?? undefined, from: 'solana' }); }} style={s.primary}>
                      <Text style={s.primaryTxt}>Pay with SOL: move it to {chainName(q.chain)}</Text>
                    </Pressable>
                  ) : unit === 'ETH' && q.chain === 'ethereum' ? (
                    <Pressable accessibilityRole="button" onPress={() => setDeposit(true)} style={s.primary}>
                      <Text style={s.primaryTxt}>Deposit ETH</Text>
                    </Pressable>
                  ) : (
                    <Text style={s.meta}>Send {unit} on {chainName(q.chain)} to {w.address}, then try again.</Text>
                  )}
                </>
              ) : q.executable && w.send ? (
                <Pressable accessibilityRole="button" onPress={buy} disabled={step.kind === 'preparing' || step.kind === 'confirm'}
                  style={[s.primary, (step.kind === 'preparing' || step.kind === 'confirm') && { opacity: 0.7 }]}>
                  <Text style={s.primaryTxt}>
                    {step.kind === 'preparing' ? 'Checking the listing…'
                      : step.kind === 'confirm' ? 'Confirm in your wallet…'
                      : `${arrived ? stepLabel(1, 2) : ''}Buy for ${total != null ? sol(total, fee ? 4 : 3, unit) : ''}`}
                  </Text>
                </Pressable>
              ) : null}
              <Text style={s.fine}>
                FloorFeed checks the purchase against the chain first. Your wallet shows the exact amount and asks you to confirm; nothing is sent until you do.
              </Text>
              {w.signTypedData && (
                <Pressable accessibilityRole="button" onPress={() => setOffering(true)} style={s.secondary}>
                  <Text style={s.secondaryTxt}>{id ? 'Make an offer instead' : 'Make a collection offer instead'}</Text>
                </Pressable>
              )}
              <Pressable accessibilityRole="link" onPress={() => { track('buy_click', { chain: q.chain }); void Linking.openURL(q.marketUrl); }}>
                <Text style={s.link}>View on OpenSea ↗</Text>
              </Pressable>
            </>
          )}

          <View style={s.footer}>
            {onPaper && step.kind !== 'sent' && (
              <Pressable accessibilityRole="button" onPress={() => { close(); onPaper(); }} style={[s.secondary, { flex: 1 }]}>
                <Text style={s.secondaryTxt}>Paper trade instead</Text>
              </Pressable>
            )}
            <Pressable accessibilityRole="button" onPress={close} style={[s.secondary, { flex: 1 }]}>
              <Text style={s.secondaryTxt}>{step.kind === 'sent' ? 'Done' : 'Cancel'}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
    <BridgeSheet open={!!bridging} to={bridging?.to} amount={bridging?.amount} from={bridging?.from}
      note="Includes a small cushion in case the cheapest listing sells while the funds move. Anything left over stays in your wallet."
      onDone={(a) => { setArrived(a); setNonce((n) => n + 1); }} onClose={() => { setBridging(null); setNonce((n) => n + 1); }} />
    {offering && (
      <EvmOfferSheet symbol={symbol} id={id} listedAt={price} open
        onClose={() => { setOffering(false); close(); }} onBuy={() => setOffering(false)} />
    )}
    <DepositSheet chain="ethereum" open={deposit} suggest={short ?? undefined}
      onClose={() => { setDeposit(false); setNonce((n) => n + 1); }} />
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={s.meta}>{label}</Text>
      <Text style={s.val}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000AA', alignItems: 'center', justifyContent: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 440, backgroundColor: C.card, borderRadius: 20, padding: 20, gap: 14, borderWidth: 1, borderColor: C.border },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: T.title,
  item: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 20, justifyContent: 'center' },
  name: T.bodyStrong,
  price: { ...T.value, marginTop: 2 },
  meta: T.meta,
  fine: T.caption,
  rows: { gap: 8, padding: 12, borderRadius: 12, backgroundColor: C.cardHi },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  val: { ...T.metaNum, color: C.text },
  err: { ...T.meta, color: C.down },
  ok: { ...T.title, color: C.up },
  okLine: { ...T.meta, color: C.up },
  link: { ...T.label, textAlign: 'center' },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  primaryTxt: { ...T.button, color: C.accentInk },
  footer: { flexDirection: 'row', gap: 10 },
  secondary: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { ...T.button, color: C.text },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  icon: { width: 28, height: 28, borderRadius: 6 },
  optionTxt: { ...T.bodyStrong, flex: 1 },
});
