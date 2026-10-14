import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { DepositSheet } from '@/components/deposit-sheet';
import { ModeChip } from '@/components/mode-toggle';
import { NftImage } from '@/components/nft-image';
import { C } from '@/constants/brand';
import { chainById, chainName } from '@/constants/chains';
import { T } from '@/constants/type';
import { api, type EvmQuote } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useEvmWallet } from '@/lib/evm-wallet';
import { sol } from '@/lib/format';
import { track } from '@/lib/analytics';

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
  const auth = useAuth();
  const [quote, setQuote] = useState<{ key: string; q: EvmQuote } | { key: string; error: string } | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  useEffect(() => { if (open) track('buy_open', { chain: 'evm' }); }, [open]);
  const [deposit, setDeposit] = useState(false);
  const [nonce, setNonce] = useState(0);
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
  const short = price != null && balance != null && q?.executable ? price - balance : null;
  const close = () => { setStep({ kind: 'idle' }); onClose(); };

  const buy = async () => {
    if (!q?.listing?.orderHash || !q.listing.protocolAddress || !w.address || !w.send) return;
    setStep({ kind: 'preparing' });
    try {
      const tx = await api.evmBuyTx({
        orderHash: q.listing.orderHash, protocolAddress: q.listing.protocolAddress, chain: q.chain, buyer: w.address,
      });
      setStep({ kind: 'confirm' });
      const hash = await w.send(tx);
      track('buy_signed', { chain: q.chain });
      setStep({ kind: 'sent', hash, url: `${tx.explorerTx ?? `${chainById(tx.chainId)?.[1].explorer ?? 'https://etherscan.io'}/tx/`}${hash}` });
    } catch (e) {
      const msg = (e as Error).message || 'The purchase did not go through.';
      setStep({ kind: 'error', message: /reject|denied|cancel/i.test(msg) ? 'You cancelled in your wallet. Nothing was sent.' : msg });
      setNonce((n) => n + 1); // refresh the quote: the listing may be gone
    }
  };

  return (
    <Modal visible={open && !deposit} transparent animationType="fade" onRequestClose={close}>
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
              <Text style={s.meta}>It usually confirms within a minute. The NFT then shows up in your Real portfolio.</Text>
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
                </View>
              </View>

              <View style={s.rows}>
                <Row label="Listing price" value={price != null ? sol(price, 3, priceUnit) : '—'} />
                <Row label="Network fee" value="shown in your wallet" />
                <Row label="Your wallet" value={balance != null ? sol(balance, 3, unit) : '—'} />
                <Row label="Wallet" value={w.walletName ?? '—'} />
              </View>

              {q.reason && <Text style={s.meta}>{q.reason}</Text>}
              {step.kind === 'error' && <Text style={s.err}>{step.message}</Text>}

              {short != null && short > 0 ? (
                <>
                  <Text style={s.err}>Not enough {unit}: you need about {sol(short, 3, unit)} more, plus gas.</Text>
                  {unit === 'ETH' ? (
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
                      : `Buy for ${price != null ? sol(price, 3, unit) : ''}`}
                  </Text>
                </Pressable>
              ) : null}
              <Text style={s.fine}>
                FloorFeed checks the purchase against the chain first. Your wallet shows the exact amount and asks you to confirm; nothing is sent until you do.
              </Text>
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
      <DepositSheet chain="ethereum" open={deposit} suggest={short ?? undefined}
        onClose={() => { setDeposit(false); setNonce((n) => n + 1); }} />
    </Modal>
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
