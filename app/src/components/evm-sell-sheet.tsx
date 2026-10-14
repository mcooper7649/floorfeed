import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { ModeChip } from '@/components/mode-toggle';
import { NftImage } from '@/components/nft-image';
import { C } from '@/constants/brand';
import { chainById, chainName } from '@/constants/chains';
import { T } from '@/constants/type';
import { api, type EvmSellQuote, type EvmTxOut } from '@/lib/api';
import { useEvmWallet } from '@/lib/evm-wallet';
import { signedSol, signedUsd, sol, usd } from '@/lib/format';
import { track } from '@/lib/analytics';
import { usePrices } from '@/lib/prices';

// Real-mode sell on an EVM chain: accept the best OpenSea offer (item, trait or
// collection) for one NFT the wallet holds. The first sale from a collection
// needs a one-time approval so OpenSea's conduit can move the NFT; FloorFeed
// builds and simulates both transactions, and the wallet asks to confirm each.

type Step = { kind: 'idle' } | { kind: 'approving'; hash?: string } | { kind: 'preparing' } | { kind: 'confirm' }
  | { kind: 'sent'; hash: string; url: string } | { kind: 'error'; message: string };

const KIND_LABEL = { item: 'Offer on this NFT', trait: 'Trait offer', collection: 'Collection offer' } as const;
const explorer = (tx: EvmTxOut) => tx.explorerTx ?? `${chainById(tx.chainId)?.[1].explorer ?? 'https://etherscan.io'}/tx/`;
const cancelled = (msg: string) => /reject|denied|cancel/i.test(msg);

export function EvmSellSheet({ symbol, id, open, onClose, onSold }: {
  symbol: string;
  id: string; // contract:tokenId
  open: boolean;
  onClose: () => void;
  onSold?: () => void;
}) {
  const w = useEvmWallet();
  const { toUsd } = usePrices();
  const [quote, setQuote] = useState<{ key: string; q: EvmSellQuote } | { key: string; error: string } | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [nonce, setNonce] = useState(0);
  const [justApproved, setJustApproved] = useState(false); // step 1 done in this session: make step 2 obvious
  const key = `${symbol}:${id}:${w.address}:${nonce}`;
  useEffect(() => { if (open) track('sell_open', { chain: 'evm' }); }, [open]);

  useEffect(() => {
    if (!open || !w.address) return;
    let alive = true;
    api.evmSellQuote(symbol, w.address, id)
      .then((q) => alive && setQuote({ key, q }))
      .catch((e) => alive && setQuote({ key, error: (e as Error).message }));
    return () => { alive = false; };
  }, [open, symbol, id, w.address, key]);

  // After the approval is sent, poll until the chain shows it, then the sell button appears.
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (polling.current) clearInterval(polling.current); }, []);
  const waitForApproval = (address: string) => {
    if (polling.current) clearInterval(polling.current);
    const started = Date.now();
    polling.current = setInterval(async () => {
      const q = await api.evmSellQuote(symbol, address, id).catch(() => null);
      if (q?.approved) {
        clearInterval(polling.current!);
        polling.current = null;
        setJustApproved(true);
        setNonce((n) => n + 1); // refetch: the quote now shows approved
        setStep({ kind: 'idle' });
      } else if (Date.now() - started > 5 * 60_000) {
        clearInterval(polling.current!);
        polling.current = null;
        setStep({ kind: 'error', message: "The approval hasn't confirmed yet. Check it in your wallet, then reopen this." });
      }
    }, 4_000);
  };

  const current = quote?.key === key ? quote : null;
  const q = current && 'q' in current ? current.q : null;
  const offer = q?.offer ?? null;
  const unit = offer?.unit ?? 'ETH';
  const pnl = offer && q?.boughtAt != null ? offer.net - q.boughtAt : null;
  // "0.0100 WETH · $24.29"
  const both = (n: number, u: string) => { const d = toUsd(n, u); return d != null ? `${sol(n, 4, u)} · ${usd(d)}` : sol(n, 4, u); };
  const busy = step.kind === 'approving' || step.kind === 'preparing' || step.kind === 'confirm';
  const close = () => {
    if (polling.current) { clearInterval(polling.current); polling.current = null; }
    setStep({ kind: 'idle' });
    onClose();
  };

  const approve = async () => {
    if (!q?.operator || !w.address || !w.send) return;
    setStep({ kind: 'approving' });
    try {
      const tx = await api.evmApproveTx({ chain: q.chain, contract: id.split(':')[0], owner: w.address, operator: q.operator });
      const hash = await w.send({ ...tx, description: `Step 1 of 2: let OpenSea move your ${q.collection.name} NFTs when you accept offers. This does not sell anything yet.` });
      track('sell_approved', { chain: q.chain });
      setStep({ kind: 'approving', hash });
      waitForApproval(w.address);
    } catch (e) {
      const msg = (e as Error).message || 'The approval did not go through.';
      setStep({ kind: 'error', message: cancelled(msg) ? 'You cancelled in your wallet. Nothing was sent.' : msg });
    }
  };

  const sell = async () => {
    if (!offer || !w.address || !w.send || !q) return;
    setStep({ kind: 'preparing' });
    try {
      const tx = await api.evmSellTx({
        orderHash: offer.orderHash, protocolAddress: offer.protocolAddress, chain: q.chain, seller: w.address, mint: id,
      });
      setStep({ kind: 'confirm' });
      const hash = await w.send({ ...tx, description: `Sell ${q.name} for ${sol(offer.net, 4, offer.currency)}` });
      track('sell_signed', { chain: q.chain, kind: offer.kind });
      setStep({ kind: 'sent', hash, url: `${explorer(tx)}${hash}` });
      onSold?.();
    } catch (e) {
      const msg = (e as Error).message || 'The sale did not go through.';
      setStep({ kind: 'error', message: cancelled(msg) ? 'You cancelled in your wallet. Nothing was sent.' : msg });
      setNonce((n) => n + 1); // refresh: the offer may be gone
    }
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
      <Pressable style={s.backdrop} onPress={close}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <View style={s.head}>
            <Text style={s.title}>Sell to the best offer</Text>
            <ModeChip mode="real" />
          </View>

          {!w.address ? (
            <Text style={s.meta}>Connect the Ethereum wallet that holds this NFT to sell it.</Text>
          ) : step.kind === 'sent' ? (
            <View style={{ gap: 10 }}>
              <Text style={s.ok}>✓ Sale submitted</Text>
              <Text style={s.meta}>
                It usually confirms within a minute. The {offer?.currency ?? 'WETH'} lands in {w.walletName ?? 'your wallet'} once it does.
              </Text>
              <Pressable accessibilityRole="link" onPress={() => Linking.openURL(step.url)} style={s.secondary}>
                <Text style={s.secondaryTxt}>View transaction ↗</Text>
              </Pressable>
            </View>
          ) : !current ? (
            <View style={s.loading}>
              <ActivityIndicator color={C.accent} />
              <Text style={s.meta}>Finding the best offer…</Text>
            </View>
          ) : !q ? (
            <Text style={s.err}>Couldn&apos;t get a quote: {'error' in current ? current.error : ''}</Text>
          ) : (
            <>
              <View style={s.item}>
                <NftImage uri={q.image} name={q.collection.name} ratio={1} radius={12} px={160} style={{ width: 72 }} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.name}>{q.name}</Text>
                  <Text style={s.meta}>{q.collection.name} · {chainName(q.chain)}</Text>
                  <Text style={s.price}>{offer ? sol(offer.net, 4, offer.currency) : '—'}</Text>
                  {offer && toUsd(offer.net, offer.currency) != null && <Text style={s.meta}>≈ {usd(toUsd(offer.net, offer.currency)!)}</Text>}
                </View>
              </View>

              {offer && (
                <View style={s.rows}>
                  <Row label={KIND_LABEL[offer.kind]} value={sol(offer.price, 4, offer.currency)} />
                  <Row label="Marketplace fee and royalty" value={`−${sol(offer.price - offer.net, 4, offer.currency)}`} />
                  <Row label="You receive" value={both(offer.net, offer.currency)} strong />
                  {q.collection.floor != null && <Row label="Collection floor" value={sol(q.collection.floor, 3, unit)} />}
                  {q.boughtAt != null && <Row label="You paid" value={sol(q.boughtAt, 3, unit)} />}
                  {pnl != null && <Row label="Profit after fees" value={`${signedSol(pnl, 4, unit)}${toUsd(pnl, unit) != null ? ` (${signedUsd(toUsd(pnl, unit)!)})` : ''}`} color={pnl >= 0 ? C.up : C.down} />}
                  <Row label="Network fee" value="shown in your wallet" />
                </View>
              )}

              {offer?.belowFloor != null && offer.belowFloor > 0.15 && (
                <Text style={s.warn}>
                  This offer is {Math.round(offer.belowFloor * 100)}% below the floor. Listing on OpenSea could get more, but may take longer to sell.
                </Text>
              )}
              {q.reason && <Text style={s.meta}>{q.reason}</Text>}
              {step.kind === 'error' && <Text style={s.err}>{step.message}</Text>}

              {q.executable && w.send && (q.approved ? (
                <View style={{ gap: 8 }}>
                  {justApproved && (
                    <View style={s.stepBox}>
                      <Text style={s.okLine}>✓ Step 1 done: selling is approved.</Text>
                      <Text style={s.meta}>Step 2 of 2: confirm the sale below. Your NFT hasn&apos;t been sold yet.</Text>
                    </View>
                  )}
                  <Pressable accessibilityRole="button" onPress={sell} disabled={busy} style={[s.primary, busy && { opacity: 0.7 }]}>
                    <Text style={s.primaryTxt}>
                      {step.kind === 'preparing' ? 'Checking the offer…'
                        : step.kind === 'confirm' ? 'Confirm the sale in your wallet…'
                        : `${justApproved ? 'Step 2: ' : ''}Sell for ${offer ? sol(offer.net, 4, offer.currency) : ''}`}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <View style={{ gap: 8 }}>
                  <Text style={s.meta}>
                    Step 1 of 2: allow OpenSea to move NFTs from this collection. You only do this once per collection; it costs a small network fee.
                  </Text>
                  <Pressable accessibilityRole="button" onPress={approve} disabled={busy} style={[s.primary, busy && { opacity: 0.7 }]}>
                    <Text style={s.primaryTxt}>
                      {step.kind === 'approving' ? (step.hash ? 'Waiting for the approval to confirm…' : 'Confirm the approval in your wallet…') : 'Step 1: Approve selling'}
                    </Text>
                  </Pressable>
                </View>
              ))}
              {offer && (
                <Text style={s.fine}>
                  Offers pay in {offer.currency}{offer.currency.startsWith('W') ? `, which you can swap 1:1 for ${offer.currency.slice(1)}` : ''}. FloorFeed checks the sale against the chain first; your wallet shows it and asks you to confirm.
                </Text>
              )}
              <Pressable accessibilityRole="link" onPress={() => Linking.openURL(q.marketUrl)}>
                <Text style={s.link}>List it on OpenSea instead ↗</Text>
              </Pressable>
            </>
          )}

          <Pressable accessibilityRole="button" onPress={close} style={s.secondary}>
            <Text style={s.secondaryTxt}>{step.kind === 'sent' ? 'Done' : 'Cancel'}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({ label, value, strong, color }: { label: string; value: string; strong?: boolean; color?: string }) {
  return (
    <View style={s.row}>
      <Text style={strong ? s.strongLabel : s.meta}>{label}</Text>
      <Text style={[s.val, strong && s.strongVal, color ? { color } : null]}>{value}</Text>
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
  strongLabel: { ...T.meta, color: C.text },
  strongVal: { ...T.bodyStrong },
  err: { ...T.meta, color: C.down },
  warn: { ...T.meta, color: C.down },
  ok: { ...T.title, color: C.up },
  okLine: { ...T.bodyStrong, color: C.up },
  stepBox: { gap: 4, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.up },
  link: { ...T.label, textAlign: 'center' },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  primaryTxt: { ...T.button, color: C.accentInk },
  secondary: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { ...T.button, color: C.text },
});
