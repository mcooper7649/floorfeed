import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DepositSheet } from '@/components/deposit-sheet';
import { ChainBadge } from '@/components/chain-badge';
import { SendSheet } from '@/components/send-sheet';
import { ModeChip, ModeToggle } from '@/components/mode-toggle';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { api, type Capabilities } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { shortAddr } from '@/lib/format';
import { useEvmWallet } from '@/lib/evm-wallet';
import { useWalletName } from '@/lib/names';
import { useProfile } from '@/lib/profile';
import { useTradeMode } from '@/lib/mode';
import { useWallet } from '@/lib/wallet';
import { track } from '@/lib/analytics';

const AMBER = '#F5B547'; // needs attention (same as Radar's caution hint)

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

  return (
    <>
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={address ? s.connected : s.connect}
        accessibilityLabel={address ? `Wallet ${address}` : auth.supported ? 'Sign in' : 'Connect wallet'}>
        {address ? (
          <>
            <ModeChip mode={mode} />
            <WalletLabel address={address} />
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

// Who's signed in, in the header: your FloorFeed account name when the wallet
// is one of yours, else the wallet's .sol / ENS name (or its FloorFeed owner's),
// else the short address.
function WalletLabel({ address }: { address: string }) {
  const auth = useAuth();
  const { profile } = useProfile();
  const looked = useWalletName(address);
  const own = profile?.name && (address === auth.embeddedAddress || address.toLowerCase() === auth.evmAddress?.toLowerCase()
    || profile.wallets.some((x) => x.toLowerCase() === address.toLowerCase()));
  const name = own ? profile!.name : looked;
  return (
    <>
      <Avatar name={name ?? address} size={24} />
      <Text style={name ? s.name : s.addr} numberOfLines={1}>{name ?? shortAddr(address)}</Text>
    </>
  );
}

// Sign in / pick a wallet when nothing is connected; the account menu when something is.
export function WalletSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const ew = useEvmWallet();
  const auth = useAuth();
  const [deposit, setDeposit] = useState(false);
  const [ethDeposit, setEthDeposit] = useState(false);
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
          <ScrollView contentContainerStyle={{ gap: w.address || ew.address ? 16 : 14 }} showsVerticalScrollIndicator={false}>
          {w.address || ew.address ? (
            <AccountView onClose={onClose} onDeposit={(c) => { onClose(); if (c === 'solana') setDeposit(true); else setEthDeposit(true); }}
              onSend={openSend} onSignIn={signIn} onSignOut={signOut} onPick={pick} />
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
              <WalletPicker onSolana={pick} />
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

// The account menu, top to bottom: who you are (tap for Profile), Practice /
// Real, your wallets with their balances, where to go next (Profile, Settings
// and security, History, Help), and Sign out. Without a FloorFeed account (a
// browser wallet only) the identity card offers sign-in instead.
function AccountView({ onClose, onDeposit, onSend, onSignIn, onSignOut, onPick }: {
  onClose: () => void;
  onDeposit: (chain: 'solana' | 'ethereum') => void;
  onSend: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onPick: (name: string) => void;
}) {
  const w = useWallet();
  const ew = useEvmWallet();
  const auth = useAuth();
  const { profile } = useProfile();
  const looked = useWalletName(w.address ?? ew.address);
  const [browser, setBrowser] = useState(false);
  const signedIn = !!auth.userId;
  const go = (to: '/profile' | '/settings' | '/history' | '/support') => { onClose(); router.push(to); };

  const name = signedIn ? profile?.name ?? profile?.fallback ?? null : looked;
  const shown = name ?? shortAddr((w.address ?? ew.address)!);
  const sec = auth.security;
  // Same nudge as onboarding's "Protect your account" step.
  const unprotected = signedIn && !!sec && (sec.mfa.length === 0 || sec.logins.length < 2);
  const canSend = w.kind === 'embedded' || ew.kind === 'embedded';
  const extras = w.kind === 'embedded' ? w.available : [];

  return (
    <>
      <View style={s.headRow}>
        <Pressable accessibilityRole={signedIn ? 'link' : undefined} disabled={!signedIn} onPress={() => go('/profile')}
          style={({ hovered }: { hovered?: boolean }) => [s.who, hovered && { backgroundColor: C.cardHi }]}>
          <Avatar name={shown} size={44} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={s.whoName} numberOfLines={1}>{shown}</Text>
            <Text style={s.meta} numberOfLines={1}>
              {signedIn ? (auth.label ?? 'Signed in') : `${w.walletName ?? ew.walletName ?? 'Wallet'} connected`}
            </Text>
          </View>
          {signedIn && <Text style={s.chev}>›</Text>}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={10} style={s.close}>
          <Text style={s.closeTxt}>✕</Text>
        </Pressable>
      </View>

      {!signedIn && auth.supported && (
        <Pressable accessibilityRole="button" onPress={onSignIn} style={s.signInCard}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.rowTitle}>Sign in to FloorFeed</Text>
            <Text style={s.meta}>Pick a name, keep your follows and practice trades on every device.</Text>
          </View>
          <Text style={[s.chev, { color: C.accent }]}>›</Text>
        </Pressable>
      )}

      <ModeToggle />

      <View style={{ gap: 8 }}>
        <Text style={s.label}>Wallets</Text>
        <View style={s.group}>
          {w.address ? (
            <WalletRow chain="solana" address={w.address} wallet={w.kind === 'embedded' ? null : w.walletName}
              onDeposit={() => onDeposit('solana')}
              onDisconnect={w.kind === 'embedded' ? undefined : async () => { await w.disconnect(); onClose(); }} />
          ) : (
            <MissingWallet chain="solana" open={browser} onToggle={() => setBrowser((v) => !v)} onPick={onPick} />
          )}
          {ew.supported && <View style={s.divider} />}
          {ew.supported && (ew.address ? (
            <WalletRow chain="ethereum" address={ew.address} wallet={ew.kind === 'embedded' ? null : ew.walletName}
              onDeposit={() => onDeposit('ethereum')}
              onDisconnect={ew.kind === 'extension' ? ew.disconnect : undefined} />
          ) : (
            <MissingWallet chain="ethereum" />
          ))}
        </View>
        {canSend && (
          <Pressable accessibilityRole="button" onPress={onSend} style={s.secondary}>
            <Text style={s.secondaryTxt}>Send or withdraw</Text>
          </Pressable>
        )}
        <Text style={s.caption}>
          {w.kind === 'embedded' || ew.kind === 'embedded'
            ? 'Keys for FloorFeed wallets are secured by Privy and never reach FloorFeed.'
            : 'FloorFeed only sees your public address. Your wallet asks before signing anything.'}
        </Text>
        {extras.length > 0 && (
          <>
            <Pressable accessibilityRole="button" onPress={() => setBrowser((v) => !v)} hitSlop={6}>
              <Text style={s.linkSmall}>{browser ? 'Hide browser wallets' : 'Use a browser wallet instead'}</Text>
            </Pressable>
            {browser && extras.map((o) => (
              <Pressable accessibilityRole="button" key={o.name} onPress={() => onPick(o.name)} disabled={w.connecting} style={s.option}>
                <Image source={o.icon} style={s.icon} />
                <Text style={s.optionTxt}>{o.name}</Text>
                <Text style={s.meta}>{w.connecting ? 'Check your wallet…' : 'Connect'}</Text>
              </Pressable>
            ))}
          </>
        )}
      </View>

      <View style={s.group}>
        {signedIn && <MenuRow glyph="◉" label="Profile" sub="Your name, theses and stats" onPress={() => go('/profile')} />}
        {signedIn && <View style={s.divider} />}
        {signedIn && (
          <MenuRow glyph="⚙" label="Settings and security" onPress={() => go('/settings')}
            sub={unprotected ? 'Turn on 2-step and add a backup sign-in' : '2-step, recovery, preferences'} warn={unprotected} />
        )}
        {signedIn && <View style={s.divider} />}
        <MenuRow glyph="↻" label="History" sub="Every buy, sale, deposit and send" onPress={() => go('/history')} />
        <View style={s.divider} />
        <MenuRow glyph="?" label="Help and support" onPress={() => go('/support')} />
      </View>

      {signedIn && (
        <Pressable accessibilityRole="button" onPress={onSignOut} hitSlop={6} style={s.signOut}>
          <Text style={s.signOutTxt}>Sign out</Text>
        </Pressable>
      )}
    </>
  );
}

// A round initial, the account's face in the header and the account menu.
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const ch = (name.replace(/^0x/i, '').match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();
  return (
    <View style={[s.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[s.avatarTxt, { fontSize: size * 0.42 }]}>{ch}</Text>
    </View>
  );
}

function WalletRow({ chain, address, wallet, onDeposit, onDisconnect }: {
  chain: 'solana' | 'ethereum'; address: string; wallet: string | null;
  onDeposit: () => void; onDisconnect?: () => void;
}) {
  const sol = useBalance(chain === 'solana' ? address : null);
  const eth = useEvmBalance(chain === 'ethereum' ? address : null);
  const [copied, setCopied] = useState(false);
  const bal = chain === 'solana' ? (sol != null ? `${sol.toFixed(4)} SOL` : '…') : (eth != null ? `${eth.toFixed(4)} ETH` : '…');
  const copy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };
  return (
    <View style={s.walletRow}>
      <ChainBadge chain={chain} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={s.balTxt} numberOfLines={1}>{bal}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Copy ${chain} address`} onPress={copy} hitSlop={4}>
          <Text style={s.meta} numberOfLines={1}>
            {copied ? 'Address copied' : `${shortAddr(address)} ⧉`}{wallet ? ` · ${wallet}` : ''}
          </Text>
        </Pressable>
      </View>
      {onDisconnect && (
        <Pressable accessibilityRole="button" onPress={onDisconnect} hitSlop={6}><Text style={s.linkSmall}>Disconnect</Text></Pressable>
      )}
      <Pressable accessibilityRole="button" accessibilityLabel={`Deposit ${chain === 'solana' ? 'SOL' : 'ETH'}`} onPress={onDeposit} style={s.pill}>
        <Text style={s.pillTxt}>Deposit</Text>
      </Pressable>
    </View>
  );
}

// A network with no wallet yet: connect one from the browser.
function MissingWallet({ chain, open, onToggle, onPick }: {
  chain: 'solana' | 'ethereum'; open?: boolean; onToggle?: () => void; onPick?: (name: string) => void;
}) {
  const ew = useEvmWallet();
  if (chain === 'solana') {
    return (
      <View style={{ gap: 8 }}>
        <View style={s.walletRow}>
          <ChainBadge chain="solana" />
          <Text style={[s.meta, { flex: 1 }]}>No Solana wallet</Text>
          <Pressable accessibilityRole="button" onPress={onToggle} style={s.pill}><Text style={s.pillTxt}>{open ? 'Cancel' : 'Connect'}</Text></Pressable>
        </View>
        {open && onPick && <SolanaOptions onPick={onPick} />}
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      <View style={s.walletRow}>
        <ChainBadge chain="ethereum" />
        <Text style={[s.meta, { flex: 1 }]}>{ew.available.length ? 'No Ethereum wallet' : 'Install MetaMask to connect one'}</Text>
      </View>
      {ew.available.map((o) => (
        <Pressable accessibilityRole="button" key={o.name} onPress={() => ew.connect(o.name)} disabled={ew.connecting} style={s.option}>
          <Image source={o.icon} style={s.icon} />
          <Text style={s.optionTxt}>{o.name}</Text>
          <Text style={s.meta}>{ew.connecting ? 'Check your wallet…' : 'Connect'}</Text>
        </Pressable>
      ))}
      {ew.error ? <Text style={s.err}>{ew.error}</Text> : null}
    </View>
  );
}

function MenuRow({ glyph, label, sub, warn, onPress }: { glyph: string; label: string; sub?: string; warn?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="link" onPress={onPress}
      style={({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [s.menuRow, (hovered || pressed) && { backgroundColor: C.card }]}>
      <View style={s.glyph}><Text style={s.glyphTxt}>{glyph}</Text></View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={s.rowTitle}>{label}</Text>
        {sub ? <Text style={[s.meta, warn && { color: AMBER }]} numberOfLines={1}>{sub}</Text> : null}
      </View>
      {warn && <View style={s.dot} />}
      <Text style={s.chev}>›</Text>
    </Pressable>
  );
}

// Phones have no top bar: a round account button for the page header that
// opens the same menu (the header WalletButton's job on desktop).
export function AccountButton() {
  const w = useWallet();
  const ew = useEvmWallet();
  const auth = useAuth();
  const { profile } = useProfile();
  const address = w.address ?? ew.address;
  const looked = useWalletName(address);
  const [open, setOpen] = useState(false);
  if (!w.supported) return null;
  const name = auth.userId ? profile?.name ?? profile?.fallback ?? null : looked;
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={address ? 'Your account' : 'Sign in'} onPress={() => setOpen(true)} hitSlop={6}>
        {address
          ? <Avatar name={name ?? address} size={34} />
          : <View style={s.signInPill}><Text style={s.signInPillTxt}>{auth.supported ? 'Sign in' : 'Connect'}</Text></View>}
      </Pressable>
      <WalletSheet open={open} onClose={() => setOpen(false)} />
    </>
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
  name: { ...T.bodyStrong, maxWidth: 160 },
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
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  who: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 6, margin: -6, borderRadius: 14 },
  whoName: { ...T.title, fontSize: 20, lineHeight: 26 },
  close: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: C.cardHi },
  closeTxt: { color: C.dim, fontSize: 13, fontWeight: '700' },
  avatar: { backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: C.accentInk, fontWeight: '800' },
  chev: { color: C.muted, fontSize: 22, lineHeight: 24, fontWeight: '300' },
  signInCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14,
    borderWidth: 1, borderColor: C.accent + '66', backgroundColor: C.accent + '12',
  },
  group: { borderRadius: 14, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: C.border, marginLeft: 12 },
  walletRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 11 },
  balTxt: { ...T.num, fontSize: 15 },
  pill: { borderRadius: 999, borderWidth: 1, borderColor: C.border, backgroundColor: C.card, paddingHorizontal: 12, paddingVertical: 6 },
  pillTxt: { color: C.text, fontSize: 13, fontWeight: '600' },
  caption: { ...T.caption },
  linkSmall: { color: C.dim, fontSize: 13, fontWeight: '600' },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 11 },
  glyph: { width: 30, height: 30, borderRadius: 9, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  glyphTxt: { color: C.text, fontSize: 15, fontWeight: '700' },
  rowTitle: { ...T.bodyStrong },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: AMBER },
  signOut: { alignSelf: 'center', paddingVertical: 4, paddingHorizontal: 12 },
  signOutTxt: { color: C.down, fontSize: 14, fontWeight: '600' },
  signInPill: { backgroundColor: C.accent, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  signInPillTxt: { ...T.button, color: C.accentInk, fontSize: 14 },
});
