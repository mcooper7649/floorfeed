import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DepositSheet } from '@/components/deposit-sheet';
import { ProfileName } from '@/components/profile-name';
import { SendSheet } from '@/components/send-sheet';
import { ModeChip, ModeToggle } from '@/components/mode-toggle';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api, type Capabilities } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { shortAddr } from '@/lib/format';
import { useEvmWallet } from '@/lib/evm-wallet';
import { useTradeMode } from '@/lib/mode';
import { useWallet } from '@/lib/wallet';
import { track } from '@/lib/analytics';

// SOL balance for the connected address, refreshed when the address changes.
export function useBalance(address: string | null) {
  const [bal, setBal] = useState<{ address: string; sol: number } | null>(null);
  useEffect(() => {
    if (!address) return;
    let alive = true;
    api.balance(address).then((b) => alive && setBal({ address, sol: b.sol })).catch(() => {});
    return () => { alive = false; };
  }, [address]);
  return bal && bal.address === address ? bal.sol : null;
}

// ETH balance (Ethereum mainnet) for the Ethereum wallet.
export function useEvmBalance(address: string | null) {
  const [bal, setBal] = useState<{ address: string; eth: number } | null>(null);
  useEffect(() => {
    if (!address) return;
    let alive = true;
    api.evmBalance(address).then((b) => alive && setBal({ address, eth: b.ethereum })).catch(() => {});
    return () => { alive = false; };
  }, [address]);
  return bal && bal.address === address ? bal.eth : null;
}

export function useCapabilities() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => { api.capabilities().then(setCaps).catch(() => {}); }, []);
  return caps;
}

// Header button: "Connect wallet", or the connected wallet with its balance.
export function WalletButton() {
  const w = useWallet();
  const ew = useEvmWallet();
  const auth = useAuth();
  const { mode } = useTradeMode();
  const [open, setOpen] = useState(false);
  const balance = useBalance(w.address);
  const ethBalance = useEvmBalance(w.address ? null : ew.address);
  if (!w.supported) return null;
  // The Solana wallet when there is one, otherwise the Ethereum wallet.
  const address = w.address ?? ew.address;
  const icon = w.address ? w.walletIcon : ew.walletIcon;

  return (
    <>
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={address ? s.connected : s.connect}
        accessibilityLabel={address ? `Wallet ${address}` : auth.supported ? 'Sign in' : 'Connect wallet'}>
        {address ? (
          <>
            <ModeChip mode={mode} />
            {icon ? <Image source={icon} style={s.icon} /> : null}
            <Text style={s.addr}>{shortAddr(address)}</Text>
            {w.address
              ? balance != null && <Text style={s.bal}>{balance.toFixed(2)} SOL</Text>
              : ethBalance != null && <Text style={s.bal}>{ethBalance.toFixed(3)} ETH</Text>}
          </>
        ) : (
          <Text style={s.connectTxt}>{auth.supported ? 'Sign in' : 'Connect wallet'}</Text>
        )}
      </Pressable>
      <WalletSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

// Profile and Settings (2-step, recovery, preferences) from the account menu.
function AccountLinks({ onGo }: { onGo: () => void }) {
  const go = (to: '/profile' | '/settings') => { onGo(); router.push(to); };
  return (
    <View style={s.signedRow}>
      <Pressable accessibilityRole="link" onPress={() => go('/profile')}><Text style={[s.link, { color: C.accent }]}>Profile</Text></Pressable>
      <Text style={s.meta}>·</Text>
      <Pressable accessibilityRole="link" onPress={() => go('/settings')}><Text style={[s.link, { color: C.accent }]}>Settings and security</Text></Pressable>
    </View>
  );
}

// Picker when disconnected; account details + disconnect when connected.
export function WalletSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const ew = useEvmWallet();
  const auth = useAuth();
  const balance = useBalance(w.address);
  const [deposit, setDeposit] = useState(false);
  const [ethDeposit, setEthDeposit] = useState(false);
  const openDeposit = () => { onClose(); setDeposit(true); };
  const openEthDeposit = () => { onClose(); setEthDeposit(true); };
  const [sendOpen, setSendOpen] = useState(false);
  const openSend = () => { onClose(); setSendOpen(true); };

  // Privy draws its own modal; close ours first so they don't stack.
  const signIn = () => { onClose(); auth.login(); };
  const signOut = async () => { await auth.logout(); onClose(); };

  const pick = async (name: string) => {
    await w.connect(name);
    track('wallet_connect', { wallet: name });
    onClose();
  };

  return (
    <>
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose}>
        <Pressable style={s.sheet} onPress={() => {}}>
          <ScrollView contentContainerStyle={{ gap: 14 }} showsVerticalScrollIndicator={false}>
          {w.kind === 'embedded' ? (
            <>
              <Text style={s.title}>Your account</Text>
              {auth.label ? <Text style={s.meta}>Signed in as {auth.label}</Text> : null}
              <Text style={s.label}>Trading mode</Text>
              <ModeToggle />
              <Text style={s.label}>Solana wallet, used in Real mode</Text>
              <View style={s.acct}>
                <View style={[s.iconBig, s.embeddedIcon]}><Text style={s.embeddedGlyph}>F</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.addrBig} selectable>{w.address}</Text>
                  <Text style={s.meta}>
                    FloorFeed wallet · {balance != null ? `${balance.toFixed(4)} SOL` : 'loading balance…'}
                  </Text>
                </View>
              </View>
              <Text style={s.note}>
                Your wallet&apos;s key is secured by Privy and never reaches FloorFeed.
              </Text>
              <ProfileName />
              <AccountLinks onGo={onClose} />
              <Pressable accessibilityRole="button" onPress={openDeposit} style={s.primary}>
                <Text style={s.primaryTxt}>Deposit SOL</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={openSend} style={s.secondary}>
                <Text style={s.secondaryTxt}>Send or withdraw</Text>
              </Pressable>
              <EvmSection onDeposit={openEthDeposit} />
              {w.available.length > 0 && (
                <>
                  <Text style={s.label}>Or use a browser wallet</Text>
                  {w.available.map((o) => (
                    <Pressable accessibilityRole="button" key={o.name} onPress={() => pick(o.name)} disabled={w.connecting} style={s.option}>
                      <Image source={o.icon} style={s.iconBig} />
                      <Text style={s.optionTxt}>{o.name}</Text>
                      <Text style={s.meta}>{w.connecting ? 'Check your wallet…' : 'Detected'}</Text>
                    </Pressable>
                  ))}
                </>
              )}
              <Pressable accessibilityRole="button" onPress={signOut} style={s.secondary}>
                <Text style={s.secondaryTxt}>Sign out</Text>
              </Pressable>
            </>
          ) : w.address ? (
            <>
              <Text style={s.title}>Your wallet</Text>
              <Text style={s.label}>Trading mode</Text>
              <ModeToggle />
              <Text style={s.label}>Solana wallet, used in Real mode</Text>
              <View style={s.acct}>
                {w.walletIcon ? <Image source={w.walletIcon} style={s.iconBig} /> : null}
                <View style={{ flex: 1 }}>
                  <Text style={s.addrBig} selectable>{w.address}</Text>
                  <Text style={s.meta}>
                    {w.walletName} · {balance != null ? `${balance.toFixed(4)} SOL` : 'loading balance…'}
                  </Text>
                </View>
              </View>
              <Text style={s.note}>
                FloorFeed only sees your public address. Nothing is signed or sent without a prompt in {w.walletName}.
              </Text>
              <Pressable accessibilityRole="button" onPress={openDeposit} style={s.primary}>
                <Text style={s.primaryTxt}>Deposit SOL</Text>
              </Pressable>
              <EvmSection onDeposit={openEthDeposit} />
              <Pressable accessibilityRole="button" onPress={async () => { await w.disconnect(); onClose(); }} style={s.secondary}>
                <Text style={s.secondaryTxt}>Disconnect</Text>
              </Pressable>
              {auth.supported && (auth.userId ? (
                <View style={{ gap: 8 }}>
                <ProfileName />
                <AccountLinks onGo={onClose} />
                <View style={s.signedRow}>
                  <Text style={[s.meta, { flex: 1 }]}>Signed in{auth.label ? ` as ${auth.label}` : ''}</Text>
                  <Pressable accessibilityRole="button" onPress={signOut}><Text style={s.link}>Sign out</Text></Pressable>
                </View>
                </View>
              ) : (
                <Pressable accessibilityRole="button" onPress={signIn}>
                  <Text style={s.link}>Sign in to keep your follows and practice trades across devices</Text>
                </Pressable>
              ))}
            </>
          ) : (
            <>
              {auth.supported && (
                <>
                  <Text style={s.title}>Sign in</Text>
                  <Text style={s.note}>
                    Use email or Google. You get a free Solana wallet with no seed phrase, and your follows and practice trades follow you across devices.
                  </Text>
                  <Pressable accessibilityRole="button" onPress={signIn} disabled={!auth.ready} style={s.primary}>
                    <Text style={s.primaryTxt}>{auth.ready ? 'Continue with email or Google' : 'Loading…'}</Text>
                  </Pressable>
                  <Text style={s.label}>Or connect a wallet</Text>
                </>
              )}
              {!auth.supported && <Text style={s.title}>Connect a wallet</Text>}
              <Text style={s.note}>FloorFeed never sees your keys or seed phrase. Your wallet asks before signing anything.</Text>
              {ew.address ? (
                <>
                  <Text style={s.label}>Solana wallet</Text>
                  <SolanaOptions onPick={pick} />
                  <EvmSection onDeposit={openEthDeposit} />
                </>
              ) : (
                <WalletPicker onSolana={pick} />
              )}
            </>
          )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
    <DepositSheet open={deposit} onClose={() => setDeposit(false)} />
    <DepositSheet chain="ethereum" open={ethDeposit} onClose={() => setEthDeposit(false)} />
    <SendSheet open={sendOpen} onClose={() => setSendOpen(false)} />
    </>
  );
}

// Detected Solana wallets, or a link to get Phantom.
function SolanaOptions({ onPick }: { onPick: (name: string) => void }) {
  const w = useWallet();
  return (
    <>
      {w.available.length === 0 ? (
        <View style={{ gap: 10 }}>
          <Text style={s.meta}>No Solana wallet was found in this browser.</Text>
          <Pressable accessibilityRole="button" onPress={() => Linking.openURL('https://phantom.com/download')} style={s.secondary}>
            <Text style={s.secondaryTxt}>Get Phantom ↗</Text>
          </Pressable>
        </View>
      ) : (
        w.available.map((o) => (
          <Pressable accessibilityRole="button" key={o.name} onPress={() => onPick(o.name)} disabled={w.connecting} style={s.option}>
            <Image source={o.icon} style={s.iconBig} />
            <Text style={s.optionTxt}>{o.name}</Text>
            <Text style={s.meta}>{w.connecting ? 'Check your wallet…' : 'Detected'}</Text>
          </Pressable>
        ))
      )}
      {w.error ? <Text style={s.err}>{w.error}</Text> : null}
    </>
  );
}

// Nothing connected yet: each browser wallet once, with a button per network it
// offers. Phantom and MetaMask both announce themselves as a Solana and an
// Ethereum wallet, which used to list each of them twice.
function WalletPicker({ onSolana }: { onSolana: (name: string) => void }) {
  const w = useWallet();
  const ew = useEvmWallet();
  const rows = new Map<string, { name: string; icon: string; solana: boolean; evm: boolean }>();
  for (const o of w.available) rows.set(o.name.toLowerCase(), { ...o, solana: true, evm: false });
  for (const o of ew.supported ? ew.available : []) {
    const r = rows.get(o.name.toLowerCase());
    if (r) r.evm = true;
    else rows.set(o.name.toLowerCase(), { ...o, solana: false, evm: true });
  }
  const chain = (label: string, busy: boolean, onPress: () => void) => (
    <Pressable accessibilityRole="button" accessibilityLabel={`Connect on ${label}`} onPress={onPress} disabled={busy}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [s.chainBtn, (pressed || hovered) && { borderColor: C.dim }]}>
      <Text style={s.chainTxt}>{busy ? 'Check wallet…' : label}</Text>
    </Pressable>
  );
  if (!rows.size) {
    return (
      <View style={{ gap: 10 }}>
        <Text style={s.meta}>No wallet was found in this browser.</Text>
        <Pressable accessibilityRole="button" onPress={() => Linking.openURL('https://phantom.com/download')} style={s.secondary}>
          <Text style={s.secondaryTxt}>Get Phantom ↗</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      {[...rows.values()].map((r) => (
        <View key={r.name} style={s.option}>
          <Image source={r.icon} style={s.iconBig} />
          <View style={{ flex: 1, gap: 8 }}>
            <Text style={s.optionTxt} numberOfLines={1}>{r.name}</Text>
            <View style={s.chains}>
              {r.solana && chain('Solana', w.connecting, () => onSolana(r.name))}
              {r.evm && chain('Ethereum', ew.connecting, () => { void ew.connect(r.name); track('wallet_connect', { wallet: r.name, chain: 'evm' }); })}
            </View>
          </View>
        </View>
      ))}
      {w.error ? <Text style={s.err}>{w.error}</Text> : null}
      {ew.error ? <Text style={s.err}>{ew.error}</Text> : null}
    </View>
  );
}

// Ethereum wallet, under the Solana one: the FloorFeed (Privy) wallet or a
// connected browser wallet, its ETH balance, and Deposit ETH.
function EvmSection({ onDeposit }: { onDeposit: () => void }) {
  const ew = useEvmWallet();
  const bal = useEvmBalance(ew.address);
  if (!ew.supported) return null;
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.label}>Ethereum wallet, used in Real mode</Text>
      {ew.address ? (
        <>
          <View style={s.evmRow}>
            {ew.walletIcon ? <Image source={ew.walletIcon} style={s.icon} /> : null}
            <Text style={s.addr} selectable>{shortAddr(ew.address)}</Text>
            <Text style={[s.meta, { flex: 1 }]}>{ew.walletName} · {bal != null ? `${bal.toFixed(4)} ETH` : '…'}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable accessibilityRole="button" onPress={onDeposit} style={[s.secondary, { flex: 1 }]}>
              <Text style={s.secondaryTxt}>Deposit ETH</Text>
            </Pressable>
            {ew.kind === 'extension' && (
              <Pressable accessibilityRole="button" onPress={ew.disconnect} style={[s.secondary, { flex: 1 }]}>
                <Text style={s.secondaryTxt}>Disconnect</Text>
              </Pressable>
            )}
          </View>
        </>
      ) : ew.available.length ? (
        ew.available.map((o) => (
          <Pressable accessibilityRole="button" key={o.name} onPress={() => ew.connect(o.name)} disabled={ew.connecting} style={s.option}>
            <Image source={o.icon} style={s.iconBig} />
            <Text style={s.optionTxt}>{o.name}</Text>
            <Text style={s.meta}>{ew.connecting ? 'Check your wallet…' : 'Connect'}</Text>
          </Pressable>
        ))
      ) : (
        <Text style={s.meta}>Sign in for a free Ethereum wallet, or install MetaMask to connect one.</Text>
      )}
      {ew.error ? <Text style={s.err}>{ew.error}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  connect: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  connectTxt: { ...T.button, color: C.accentInk },
  evmRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  connected: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.card, borderRadius: 12,
    borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 8,
  },
  icon: { width: 20, height: 20, borderRadius: 5 },
  iconBig: { width: 36, height: 36, borderRadius: 9 },
  addr: { ...T.bodyStrong, fontVariant: ['tabular-nums'] },
  bal: T.metaNum,
  backdrop: { flex: 1, backgroundColor: '#000000AA', alignItems: 'center', justifyContent: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 420, maxHeight: '92%', backgroundColor: C.card, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: C.border },
  title: T.title,
  note: T.meta,
  meta: T.meta,
  err: { ...T.meta, color: C.down },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14,
    backgroundColor: C.cardHi, borderWidth: 1, borderColor: C.border,
  },
  optionTxt: { ...T.bodyStrong, flex: 1 },
  chains: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chainBtn: { borderRadius: 9, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, paddingHorizontal: 10, paddingVertical: 7 },
  chainTxt: { fontSize: 13, lineHeight: 17, fontWeight: '600', color: C.text },
  acct: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  addrBig: { ...T.num, fontSize: 13 },
  secondary: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  secondaryTxt: { ...T.button, color: C.text },
  primary: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  primaryTxt: { ...T.button, color: C.accentInk },
  label: { ...T.label, marginTop: 4 },
  link: { ...T.label, textAlign: 'center' },
  signedRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  embeddedIcon: { backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  embeddedGlyph: { color: C.accentInk, fontWeight: '700', fontSize: 18 },
});
