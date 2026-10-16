import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { TopNav } from '@/components/top-nav';
import { Button, Chip } from '@/components/ui';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { track } from '@/lib/analytics';
import { api, type SupportTopic } from '@/lib/api';
import { useEvmWallet } from '@/lib/evm-wallet';
import { shortAddr } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useTradeMode } from '@/lib/mode';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';
import { useWallet } from '@/lib/wallet';

// "Report a problem". The report goes to the server (support.ts), which keeps
// it and pings the team. Other screens can link here prefilled:
// /support?topic=trade&tx=<hash>&detail=<error text>&from=<screen>.

const TOPICS: { id: SupportTopic; label: string; hint: string }[] = [
  { id: 'bug', label: 'Something broke', hint: 'What were you doing, and what happened instead?' },
  { id: 'trade', label: 'A trade or transfer', hint: 'What were you buying, selling, listing or moving? Paste the transaction link below if you have it.' },
  { id: 'wallet', label: 'Wallet or sign-in', hint: 'Which wallet do you use (MetaMask, Phantom, email sign-in...) and what went wrong?' },
  { id: 'idea', label: 'An idea', hint: 'What would make FloorFeed better for you?' },
  { id: 'other', label: 'Something else', hint: 'Tell us what’s on your mind.' },
];
const isTopic = (t?: string): t is SupportTopic => TOPICS.some((x) => x.id === t);

export default function Support() {
  useTitle('Support | FloorFeed');
  const params = useLocalSearchParams<{ topic?: string; tx?: string; detail?: string; from?: string }>();
  const { pad, wide } = useLayout();
  const { userId } = useSession();
  const { mode } = useTradeMode();
  const sw = useWallet();
  const ew = useEvmWallet();
  const wallets = [ew.address, sw.address].filter((a): a is string => !!a);

  const [topic, setTopic] = useState<SupportTopic>(isTopic(params.topic) ? params.topic : 'bug');
  const [message, setMessage] = useState('');
  const detail = params.detail?.slice(0, 500);
  const [tx, setTx] = useState(params.tx ?? '');
  const [contact, setContact] = useState('');
  const [shareWallets, setShareWallets] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);

  const hint = TOPICS.find((t) => t.id === topic)!.hint;
  const ready = message.trim().length >= 10 && !sending;

  const submit = async () => {
    if (!ready) return;
    setSending(true);
    setError(null);
    try {
      const r = await api.support({
        topic,
        message: message.trim() + (detail ? `\n\nError shown: ${detail}` : ''),
        contact: contact.trim() || undefined,
        tx: tx.trim() || undefined,
        wallets: shareWallets && wallets.length ? wallets : undefined,
        userId: userId ?? undefined,
        page: params.from || undefined,
        mode,
      });
      track('support_sent', { topic });
      setSent(r.id);
    } catch (e) {
      setError((e as Error).message || 'Couldn’t send that. Try again in a minute.');
    } finally {
      setSending(false);
    }
  };

  const reset = () => {
    setSent(null);
    setMessage('');
    setTx('');
  };

  return (
    <View style={s.fill}>
      {Platform.OS === 'web' && <TopNav back />}
      <ScrollView contentContainerStyle={[s.page, { paddingHorizontal: pad }]} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 6 }}>
          <Text {...display} style={wide ? T.displayL : T.display}>Support</Text>
          <Text style={T.meta}>Found a bug, stuck on a trade, or have an idea? Tell us here. A person reads every report.</Text>
        </View>

        {sent != null ? (
          <View style={s.card}>
            <Text style={[T.title, { color: C.up }]}>Thanks, we got it.</Text>
            <Text style={s.p}>
              Your report is #{sent}.{' '}
              {contact.trim() ? `We’ll reply at ${contact.trim()}.` : 'You didn’t leave a contact, so we can’t reply directly, but we’ll look into it.'}
            </Text>
            <View style={s.row}>
              <Button label="Back to FloorFeed" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
              <Button label="Send another" tone="secondary" onPress={reset} />
            </View>
          </View>
        ) : (
          <View style={s.card}>
            <Text style={s.label}>What’s it about?</Text>
            <View style={s.chips}>
              {TOPICS.map((t) => <Chip key={t.id} label={t.label} on={topic === t.id} onPress={() => setTopic(t.id)} />)}
            </View>

            <Text style={s.label}>What happened?</Text>
            <TextInput
              value={message}
              onChangeText={setMessage}
              placeholder={hint}
              placeholderTextColor={C.muted}
              multiline
              maxLength={4000}
              style={[s.input, s.area]}
              accessibilityLabel="What happened"
            />

            {detail && (
              <View style={s.detail}>
                <Text style={s.opt}>We’ll include the error you saw:</Text>
                <Text style={[T.meta, { color: C.text }]} selectable>{detail}</Text>
              </View>
            )}

            {(topic === 'trade' || topic === 'bug' || !!tx) && (
              <>
                <Text style={s.label}>Transaction link or hash <Text style={s.opt}>(optional)</Text></Text>
                <TextInput value={tx} onChangeText={setTx} placeholder="0x… or a Solscan / Etherscan link" placeholderTextColor={C.muted}
                  autoCapitalize="none" autoCorrect={false} style={s.input} accessibilityLabel="Transaction link or hash" />
              </>
            )}

            <Text style={s.label}>How can we reach you? <Text style={s.opt}>(optional)</Text></Text>
            <TextInput value={contact} onChangeText={setContact} placeholder="Email or X handle" placeholderTextColor={C.muted}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address" style={s.input} accessibilityLabel="Contact" />

            {wallets.length > 0 && (
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: shareWallets }} onPress={() => setShareWallets((v) => !v)} style={s.check}>
                <View style={[s.box, shareWallets && s.boxOn]}>{shareWallets && <Text style={s.tick}>✓</Text>}</View>
                <Text style={[s.p, { flex: 1 }]}>
                  Include my wallet address{wallets.length > 1 ? 'es' : ''} ({wallets.map((a) => shortAddr(a)).join(', ')}) so you can look up what happened.
                  {' '}<Text style={s.opt}>Public addresses only. We’ll never ask for your seed phrase or private key.</Text>
                </Text>
              </Pressable>
            )}

            {error && <Text style={s.err}>{error}</Text>}
            <Button label={sending ? 'Sending…' : 'Send report'} onPress={submit} disabled={!ready} />
            {!ready && !sending && message.trim().length > 0 && <Text style={s.opt}>A few more words, please (10+ characters).</Text>}
          </View>
        )}

        <View style={s.more}>
          <Text style={s.label}>Other ways to reach us</Text>
          <Text style={s.p}>
            Message <Text style={s.link} onPress={() => Linking.openURL('https://x.com/FloorFeed')}>@FloorFeed on X</Text>, or read{' '}
            <Text style={s.link} onPress={() => router.push('/how-it-works')}>how FloorFeed works</Text>.
          </Text>
          <Text style={s.opt}>FloorFeed never holds your funds and will never DM you first asking you to sign something or share a seed phrase.</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  page: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingTop: 28, paddingBottom: 80, gap: 18 },
  card: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 18, gap: 12 },
  label: { ...T.bodyStrong },
  opt: { ...T.caption },
  p: { ...T.body, color: C.dim },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: {
    backgroundColor: C.bg, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    color: C.text, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15,
  },
  area: { minHeight: 140, textAlignVertical: 'top' },
  check: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  box: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: C.border, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  boxOn: { backgroundColor: C.accent, borderColor: C.accent },
  tick: { color: C.accentInk, fontSize: 13, fontWeight: '700', lineHeight: 15 },
  err: { ...T.meta, color: C.down },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  detail: { gap: 2, padding: 10, borderRadius: 10, backgroundColor: C.cardHi },
  more: { gap: 6, paddingHorizontal: 4 },
  link: { color: C.accent },
});
