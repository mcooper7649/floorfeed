import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DateTime, FilePick, objectUrl } from '@/components/dom-input';
import { TopNav } from '@/components/top-nav';
import { Button, Card, Chip } from '@/components/ui';
import { C } from '@/constants/brand';
import { T, display } from '@/constants/type';
import { recordTx } from '@/lib/activity';
import { track } from '@/lib/analytics';
import { api, type LaunchConfig, type LaunchDraft, type LaunchDraftIn, type LaunchedCollection, type LaunchPhaseIn } from '@/lib/api';
import { useEvmWallet } from '@/lib/evm-wallet';
import { readPicked, traitCounts, uploadArt, uploadSingle, type Picked } from '@/lib/launch-upload';
import { useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { useTitle } from '@/lib/use-title';

// The launchpad wizard: Details → Art → Mint → Launch, then Manage once live.
// Everything saves to a draft on our server (launch.ts); the launch itself is
// one transaction from the creator's wallet, which then owns the contract.

type Step = 'details' | 'art' | 'mint' | 'launch' | 'manage';
const STEPS: { id: Step; label: string }[] = [
  { id: 'details', label: '1 · Details' }, { id: 'art', label: '2 · Art' }, { id: 'mint', label: '3 · Mint' }, { id: 'launch', label: '4 · Launch' },
];
const ROYALTIES = [0, 250, 500, 750, 1000];
const hourFromNow = () => Math.ceil(Date.now() / 3_600_000) * 3600 + 3600;

const fromDraft = (d: LaunchDraft): LaunchDraftIn => ({
  chain: d.chain, name: d.name, symbol: d.symbol, description: d.description, website: d.website ?? null, twitter: d.twitter ?? null,
  royaltyBps: d.royaltyBps, royaltyTo: d.royaltyTo ?? null, storage: d.storage === 'onchain' ? 'onchain' : 'ipfs',
  reveal: d.reveal === 'instant' ? 'instant' : 'later', coverCid: d.coverCid ?? null, bannerCid: d.bannerCid ?? null,
  placeholderCid: d.placeholderCid ?? null, phases: d.phases,
});

export default function CreateWizard() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const { pad, wide } = useLayout();
  const { userId } = useSession();
  const [config, setConfig] = useState<LaunchConfig | null>(null);
  const [draft, setDraft] = useState<LaunchDraft | null>(null);
  const [edited, setForm] = useState<LaunchDraftIn | null>(null);
  const [firstStart] = useState(hourFromNow);
  // A new collection starts from defaults; edits (or a loaded draft) replace them.
  const blank = useMemo<LaunchDraftIn | null>(() => (config ? {
    chain: config.chains[0]?.id ?? 'base', name: '', symbol: '', description: '', royaltyBps: 500, storage: 'ipfs', reveal: 'later',
    phases: [{ name: 'Public', start: firstStart, end: 0, price: '0.001', maxPerWallet: 5, allowlist: false }],
  } : null), [config, firstStart]);
  const form = edited ?? (isNew ? blank : null);
  const [step, setStep] = useState<Step>('details');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useTitle(draft ? `${draft.name} · Launch | FloorFeed` : 'New collection | FloorFeed');

  useEffect(() => { api.launchConfig().then(setConfig).catch(() => setError('Couldn’t reach FloorFeed.')); }, []);
  // Load the draft (or start a blank form once the config says which chains exist).
  useEffect(() => {
    if (!userId) return;
    if (isNew) return;
    api.getLaunch(userId, id).then((d) => {
      setDraft(d);
      setForm(fromDraft(d));
      if (d.status === 'live') setStep('manage');
    }).catch((e: Error) => setError(e.message));
    // Re-load only when the id changes (after the first save replaces "new").
  }, [userId, id, isNew]);

  const set = useCallback((patch: Partial<LaunchDraftIn>) => setForm((f) => { const base = f ?? blank; return base ? { ...base, ...patch } : f; }), [blank]);

  const save = async (next?: Step) => {
    if (!form || !userId) return;
    setSaving(true);
    setError(null);
    try {
      const d = draft ? await api.updateLaunch(userId, draft.id, form) : await api.createLaunch(userId, form);
      setDraft(d);
      setSavedAt(Date.now());
      if (!draft) { track('launch_draft', { chain: form.chain }); router.replace({ pathname: '/create/[id]', params: { id: d.id } }); }
      if (next) setStep(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const refresh = useCallback(async () => {
    if (!userId || !draft) return;
    const d = await api.getLaunch(userId, draft.id);
    setDraft(d);
    if (d.status === 'live') setStep('manage');
  }, [userId, draft]);

  const web = Platform.OS === 'web';
  const native = config?.chains.find((c) => c.id === form?.chain)?.native ?? 'ETH';

  return (
    <View style={s.fill}>
      {web && <TopNav back />}
      <ScrollView contentContainerStyle={[s.page, { paddingHorizontal: pad }]} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => router.push('/create')}><Text style={s.crumb}>‹ Your collections</Text></Pressable>
        <Text {...display} style={wide ? T.displayL : T.display}>{draft?.name || 'New collection'}</Text>
        {!web ? (
          <Card><Text style={T.body}>Creating a collection works on the website for now.</Text></Card>
        ) : !form || !config ? (
          error ? <Text style={s.err}>{error}</Text> : <ActivityIndicator color={C.accent} style={{ marginTop: 24 }} />
        ) : (
          <>
            {step !== 'manage' && (
              <View style={s.tabs}>
                {STEPS.map((t) => {
                  const locked = !draft && t.id !== 'details';
                  return (
                    <Pressable key={t.id} disabled={locked} onPress={() => setStep(t.id)} style={[s.tab, step === t.id && s.tabOn, locked && { opacity: 0.4 }]}>
                      <Text style={[s.tabTxt, step === t.id && { color: C.text }]}>{t.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {error && <Text style={s.err}>{error}</Text>}

            {step === 'details' && (
              <Details form={form} set={set} config={config} draft={draft} userId={userId!} native={native}
                onSave={() => save('art')} saving={saving} savedAt={savedAt} />
            )}
            {step === 'art' && draft && <Art draft={draft} userId={userId!} gateway={config.gateway} onChanged={refresh} onNext={() => setStep('mint')} />}
            {step === 'mint' && draft && (
              <Mint form={form} set={set} draft={draft} userId={userId!} native={native} saving={saving}
                onSave={() => save('launch')} onAllowlist={refresh} />
            )}
            {step === 'launch' && draft && <Launch draft={draft} form={form} userId={userId!} config={config} onChanged={refresh} goto={setStep} />}
            {step === 'manage' && draft && <Manage draft={draft} userId={userId!} config={config} />}
          </>
        )}
      </ScrollView>
    </View>
  );
}

// --- 1. Details ---

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={T.bodyStrong}>{label}</Text>
      {children}
      {hint && <Text style={T.caption}>{hint}</Text>}
    </View>
  );
}

function ImagePick({ label, cid, gateway, disabled, onFile }: { label: string; cid?: string | null; gateway: string; disabled: boolean; onFile: (f: File) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <View style={s.imgPick}>
      <View style={s.thumb}>{cid ? <Image source={`${gateway}${cid}`} style={StyleSheet.absoluteFill} contentFit="cover" /> : <Text style={T.caption}>None</Text>}</View>
      <View style={{ flex: 1, gap: 6 }}>
        <FilePick label={busy ? 'Uploading…' : cid ? `Change ${label.toLowerCase()}` : `Add ${label.toLowerCase()}`} accept="image/*" disabled={disabled || busy}
          onFiles={async ([f]) => { setBusy(true); setErr(null); try { await onFile(f); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }} />
        {err && <Text style={s.err}>{err}</Text>}
      </View>
    </View>
  );
}

function Details({ form, set, config, draft, userId, native, onSave, saving, savedAt }: {
  form: LaunchDraftIn; set: (p: Partial<LaunchDraftIn>) => void; config: LaunchConfig; draft: LaunchDraft | null; userId: string;
  native: string; onSave: () => void; saving: boolean; savedAt: number | null;
}) {
  const upload = (key: 'coverCid' | 'bannerCid' | 'placeholderCid') => async (f: File) => {
    if (!draft) return;
    const cid = await uploadSingle(userId, draft.id, f);
    set({ [key]: cid });
  };
  return (
    <Card style={{ gap: 16 }}>
      <Field label="Name"><TextInput value={form.name} onChangeText={(name) => set({ name, symbol: form.symbol || name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() })} placeholder="Floor Frogs" placeholderTextColor={C.muted} style={s.input} maxLength={60} /></Field>
      <Field label="Symbol" hint="Short ticker, letters and numbers (e.g. FROG).">
        <TextInput value={form.symbol} onChangeText={(v) => set({ symbol: v.replace(/[^A-Za-z0-9]/g, '').toUpperCase() })} placeholder="FROG" placeholderTextColor={C.muted} style={s.input} maxLength={12} autoCapitalize="characters" />
      </Field>
      <Field label="Description"><TextInput value={form.description} onChangeText={(description) => set({ description })} multiline placeholder="What is this collection?" placeholderTextColor={C.muted} style={[s.input, { minHeight: 90, textAlignVertical: 'top' }]} maxLength={2000} /></Field>
      <Field label="Network" hint="Where the collection lives. It can’t be moved later.">
        <View style={s.chips}>{config.chains.map((c) => <Chip key={c.id} label={c.name} on={form.chain === c.id} onPress={() => set({ chain: c.id })} />)}</View>
      </Field>
      <Field label="Creator earnings on resales" hint={`Paid to you on marketplaces that honor royalties. Prices on this network are in ${native}.`}>
        <View style={s.chips}>{ROYALTIES.map((b) => <Chip key={b} label={`${b / 100}%`} on={form.royaltyBps === b} onPress={() => set({ royaltyBps: b })} />)}</View>
      </Field>
      <Field label="Where the art is stored">
        <View style={s.chips}>
          <Chip label="IPFS (recommended)" on={form.storage === 'ipfs'} onPress={() => set({ storage: 'ipfs' })} />
          <Chip label="Fully on chain (soon)" on={form.storage === 'onchain'} onPress={() => set({ storage: 'onchain' })} />
        </View>
        <Text style={T.caption}>{form.storage === 'ipfs'
          ? 'IPFS: any size, cheap, the standard for NFT collections. FloorFeed pins your files.'
          : 'On chain: art lives in the contract itself, forever, but images must be small and you pay gas per image. Coming soon; IPFS for now.'}</Text>
      </Field>
      <Field label="Reveal">
        <View style={s.chips}>
          <Chip label="After the mint (recommended)" on={form.reveal === 'later'} onPress={() => set({ reveal: 'later' })} />
          <Chip label="Right away" on={form.reveal === 'instant'} onPress={() => set({ reveal: 'instant' })} />
        </View>
        <Text style={T.caption}>{form.reveal === 'later'
          ? 'Collectors see a placeholder until you reveal; the reveal shuffles which art each token gets, so nobody can snipe rare pieces.'
          : 'Each token shows its art as soon as it’s minted. Rare pieces can be sniped by watching which numbers are next.'}</Text>
      </Field>
      <Field label="Images" hint={draft ? 'Square cover works best (shown in the Mint tab). Banner 3:1.' : 'Save the details first, then add images.'}>
        <ImagePick label="Cover" cid={form.coverCid} gateway={config.gateway} disabled={!draft} onFile={upload('coverCid')} />
        <ImagePick label="Banner" cid={form.bannerCid} gateway={config.gateway} disabled={!draft} onFile={upload('bannerCid')} />
        {form.reveal === 'later' && <ImagePick label="Placeholder" cid={form.placeholderCid} gateway={config.gateway} disabled={!draft} onFile={upload('placeholderCid')} />}
      </Field>
      <Field label="Links (optional)">
        <TextInput value={form.website ?? ''} onChangeText={(v) => set({ website: v.trim() || null })} placeholder="https://yourproject.xyz" placeholderTextColor={C.muted} style={s.input} autoCapitalize="none" />
        <TextInput value={form.twitter ?? ''} onChangeText={(v) => set({ twitter: v.replace(/[^A-Za-z0-9_]/g, '') || null })} placeholder="X handle (without @)" placeholderTextColor={C.muted} style={s.input} autoCapitalize="none" />
      </Field>
      <Button label={saving ? 'Saving…' : draft ? 'Save and continue' : 'Save and add art'} onPress={onSave} disabled={saving || !form.name.trim() || !form.symbol} />
      {savedAt && <Text style={T.caption}>Saved.</Text>}
    </Card>
  );
}

// --- 2. Art ---

function Art({ draft, userId, gateway, onChanged, onNext }: { draft: LaunchDraft; userId: string; gateway: string; onChanged: () => Promise<void>; onNext: () => void }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ idx: number; cid: string; name?: string; attributes: { trait_type: string; value: string | number }[] }[] | null>(null);
  const signal = useRef({ stop: false });

  useEffect(() => {
    if (!draft.items) return;
    api.launchListItems(userId, draft.id, 0, 24).then((r) => setSaved(r.items)).catch(() => {});
  }, [userId, draft.id, draft.items]);

  const previews = useMemo(() => (picked?.items ?? []).slice(0, 12).map((it) => ({ ...it, url: objectUrl(it.file) })), [picked]);
  const traits = useMemo(() => (picked ? traitCounts(picked.items) : null), [picked]);
  const pick = async (files: File[]) => { setErr(null); setPicked(await readPicked(files)); };
  const upload = async () => {
    if (!picked?.items.length) return;
    signal.current.stop = false;
    setErr(null);
    setProgress({ done: 0, total: picked.items.length });
    try {
      await uploadArt(userId, draft.id, picked.items, (done, total) => setProgress({ done, total }), signal.current);
      track('launch_art', { count: picked.items.length });
      setPicked(null);
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  return (
    <Card style={{ gap: 14 }}>
      <Text style={T.bodyStrong}>{draft.items ? `${draft.items.toLocaleString()} artworks uploaded` : 'Upload your collection'}</Text>
      <Text style={T.meta}>
        Pick a folder (or files) of images, numbered 1, 2, 3… Add traits with JSON files named like the images (1.json, as most generators make), or one CSV with a
        “file” column plus one column per trait. Up to 10,000 items.
      </Text>
      {!progress && (
        <View style={s.row}>
          <View style={{ flex: 1 }}><FilePick label="Choose a folder" folder multiple onFiles={pick} /></View>
          <View style={{ flex: 1 }}><FilePick label="Choose files" multiple accept="image/*,video/mp4,.json,.csv" onFiles={pick} /></View>
        </View>
      )}

      {picked && (
        <View style={{ gap: 10 }}>
          <Text style={T.body}>
            {picked.items.length.toLocaleString()} images found
            {picked.traitSource !== 'none' ? `, traits from ${picked.traitSource.toUpperCase()}` : ', no traits'}.
          </Text>
          {picked.problems.map((p) => <Text key={p} style={s.warn}>{p}</Text>)}
          <View style={s.grid}>
            {previews.map((p) => (
              <View key={p.idx} style={s.cell}>
                <Image source={p.url} style={s.cellImg} contentFit="cover" />
                <Text style={T.caption} numberOfLines={1}>#{p.idx} {p.name ?? ''}</Text>
              </View>
            ))}
          </View>
          {traits && traits.size > 0 && (
            <View style={{ gap: 4 }}>
              <Text style={T.label}>Traits</Text>
              {[...traits.entries()].slice(0, 8).map(([t, vals]) => (
                <Text key={t} style={T.caption} numberOfLines={2}>
                  <Text style={{ color: C.text }}>{t}</Text>: {[...vals.entries()].sort((a, b) => a[1] - b[1]).slice(0, 6)
                    .map(([v, n]) => `${v} ${((n / picked.items.length) * 100).toFixed(n / picked.items.length < 0.1 ? 1 : 0)}%`).join(' · ')}
                </Text>
              ))}
            </View>
          )}
          {picked.items.length > 10_000 ? <Text style={s.err}>That’s more than 10,000 items.</Text> : (
            <Button label={`Upload ${picked.items.length.toLocaleString()} artworks${draft.items ? ' (replaces the current set)' : ''}`} onPress={upload} />
          )}
        </View>
      )}

      {progress && (
        <View style={{ gap: 6 }}>
          <View style={s.bar}><View style={[s.fill2, { width: `${(progress.done / progress.total) * 100}%` }]} /></View>
          <Text style={T.metaNum}>Uploading {progress.done.toLocaleString()} / {progress.total.toLocaleString()}… keep this tab open.</Text>
          <Pressable onPress={() => { signal.current.stop = true; }}><Text style={s.link}>Stop</Text></Pressable>
        </View>
      )}
      {err && <Text style={s.err}>{err}</Text>}

      {!picked && saved && saved.length > 0 && (
        <View style={s.grid}>
          {saved.map((it) => (
            <View key={it.idx} style={s.cell}>
              <Image source={`${gateway}${it.cid}`} style={s.cellImg} contentFit="cover" />
              <Text style={T.caption} numberOfLines={1}>#{it.idx} {it.name ?? ''}</Text>
            </View>
          ))}
        </View>
      )}
      {draft.items > 0 && !picked && !progress && <Button label="Continue to mint phases" onPress={onNext} />}
    </Card>
  );
}

// --- 3. Mint phases ---

function Mint({ form, set, draft, userId, native, saving, onSave, onAllowlist }: {
  form: LaunchDraftIn; set: (p: Partial<LaunchDraftIn>) => void; draft: LaunchDraft; userId: string; native: string;
  saving: boolean; onSave: () => void; onAllowlist: () => Promise<void>;
}) {
  const [lists, setLists] = useState<Record<number, string>>({});
  const [listMsg, setListMsg] = useState<Record<number, string>>({});
  const phases = form.phases;
  const update = (i: number, patch: Partial<LaunchPhaseIn>) => set({ phases: phases.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const add = () => {
    const last = phases[phases.length - 1];
    set({ phases: [...phases, { name: 'Public', start: last?.end || (last ? last.start + 86_400 : hourFromNow()), end: 0, price: last?.price ?? '0.001', maxPerWallet: 5, allowlist: false }] });
  };
  const saveList = async (i: number) => {
    const wallets = (lists[i] ?? '').split(/[\s,;]+/).filter(Boolean);
    try {
      const r = await api.launchAllowlist(userId, draft.id, i, wallets);
      setListMsg((m) => ({ ...m, [i]: `${r.wallets.toLocaleString()} wallets saved${r.skipped ? `, ${r.skipped} skipped (not addresses)` : ''}.` }));
      await onAllowlist();
    } catch (e) {
      setListMsg((m) => ({ ...m, [i]: (e as Error).message }));
    }
  };
  return (
    <Card style={{ gap: 14 }}>
      <Text style={T.meta}>Supply is your artwork count ({draft.items.toLocaleString()}). Phases run in order; an allowlist phase is only for the wallets you list; a FloorFeed members phase is for anyone signed in to FloorFeed.</Text>
      {phases.map((p, i) => (
        <View key={i} style={s.phase}>
          <View style={s.row}>
            <TextInput value={p.name} onChangeText={(name) => update(i, { name })} style={[s.input, { flex: 1 }]} maxLength={40} />
            {phases.length > 1 && <Pressable onPress={() => set({ phases: phases.filter((_, j) => j !== i) })}><Text style={s.link}>Remove</Text></Pressable>}
          </View>
          <View style={s.chips}>
            <Chip label="Public" on={!p.allowlist && !p.members} onPress={() => update(i, { allowlist: false, members: false })} />
            <Chip label="Allowlist" on={p.allowlist && !p.members} onPress={() => update(i, { allowlist: true, members: false })} />
            <Chip label="FloorFeed members" on={!!p.members} onPress={() => update(i, { allowlist: false, members: true })} />
          </View>
          <View style={s.row}>
            <View style={{ flex: 1, gap: 4 }}><Text style={T.label}>Starts</Text><DateTime label="Starts" value={p.start} onChange={(start) => update(i, { start })} /></View>
            <View style={{ flex: 1, gap: 4 }}><Text style={T.label}>Ends (optional)</Text><DateTime label="Ends" value={p.end} onChange={(end) => update(i, { end })} /></View>
          </View>
          <View style={s.row}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={T.label}>Price ({native}, 0 = free)</Text>
              <TextInput value={p.price} onChangeText={(v) => update(i, { price: v.replace(/[^0-9.]/g, '') })} keyboardType="decimal-pad" style={s.input} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={T.label}>Max per {p.members ? 'account' : 'wallet'} (0 = no limit)</Text>
              <TextInput value={String(p.maxPerWallet)} onChangeText={(v) => update(i, { maxPerWallet: Math.min(1000, Number(v.replace(/\D/g, '')) || 0) })} keyboardType="number-pad" style={s.input} />
            </View>
          </View>
          {p.members && (
            <Text style={T.caption}>Anyone signed in to FloorFeed can mint. FloorFeed checks the account at mint time, and the contract enforces the limit per account, even across several wallets.</Text>
          )}
          {p.allowlist && !p.members && (
            <View style={{ gap: 6 }}>
              <Text style={T.label}>Allowlist {draft.allowlists[i] ? `(${draft.allowlists[i].toLocaleString()} saved)` : ''}</Text>
              <TextInput value={lists[i] ?? ''} onChangeText={(v) => setLists((l) => ({ ...l, [i]: v }))} multiline placeholder="Paste wallet addresses (0x…), one per line or separated by commas"
                placeholderTextColor={C.muted} style={[s.input, { minHeight: 80, textAlignVertical: 'top', fontSize: 13 }]} autoCapitalize="none" />
              <Pressable onPress={() => saveList(i)} style={s.smallBtn}><Text style={T.label}>Save list</Text></Pressable>
              <Text style={T.caption}>Save the phases first if you just switched this one to Allowlist.</Text>
              {listMsg[i] && <Text style={T.caption}>{listMsg[i]}</Text>}
            </View>
          )}
        </View>
      ))}
      {phases.length < 4 && <Pressable onPress={add} style={s.smallBtn}><Text style={T.label}>+ Add a phase</Text></Pressable>}
      <Text style={T.caption}>Collectors also pay FloorFeed’s small fee per NFT (shown before they mint). You receive the full price you set.</Text>
      <Button label={saving ? 'Saving…' : 'Save phases and continue'} onPress={onSave} disabled={saving} />
    </Card>
  );
}

// --- 4. Launch ---

function Launch({ draft, form, userId, config, onChanged, goto }: {
  draft: LaunchDraft; form: LaunchDraftIn; userId: string; config: LaunchConfig; onChanged: () => Promise<void>; goto: (s: Step) => void;
}) {
  const w = useEvmWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const chainName = config.chains.find((c) => c.id === draft.chain)?.name ?? draft.chain;
  const checks = [
    { ok: draft.items > 0, text: `${draft.items.toLocaleString()} artworks uploaded`, fix: 'art' as Step },
    { ok: !!draft.coverCid, text: 'Cover image (recommended)', fix: 'details' as Step, optional: true },
    { ok: draft.storage === 'ipfs', text: 'Storage: IPFS', fix: 'details' as Step },
    { ok: draft.phases.every((p, i) => !p.allowlist || (draft.allowlists[i] ?? 0) > 0), text: 'Allowlists filled in', fix: 'mint' as Step },
    { ok: draft.phases.every((p) => !p.end || p.end > p.start), text: 'Phase dates make sense', fix: 'mint' as Step },
  ];
  const ready = checks.every((c) => c.ok || c.optional);

  const prepare = async () => {
    setBusy('Pinning metadata to IPFS…');
    setErr(null);
    try { await api.launchMetadata(userId, draft.id); await onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const launch = async () => {
    if (!w.address || !w.send) return;
    setErr(null);
    setBusy('Checking the launch…');
    try {
      const tx = await api.launchDeployTx(userId, draft.id, w.address);
      setBusy('Confirm in your wallet…');
      const hash = await w.send({ ...tx, description: `Launch ${draft.name} on ${chainName}` });
      track('launch_signed', { chain: draft.chain });
      recordTx({ hash, wallet: w.address, chain: draft.chain, kind: 'mint', title: `Launched ${draft.name}`, amount: null, unit: null });
      setBusy('Waiting for the network…');
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        try { await api.launchDeployed(userId, draft.id, hash); await onChanged(); return; } catch (e) {
          if (!/not confirmed/i.test((e as Error).message)) throw e;
        }
      }
      throw new Error('Still not confirmed after 4 minutes. Check your wallet; this page picks it up once it lands.');
    } catch (e) {
      const m = (e as Error).message;
      setErr(/reject|denied|cancel/i.test(m) ? 'You cancelled in your wallet. Nothing was sent.' : m);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card style={{ gap: 14 }}>
      <Text style={T.bodyStrong}>Ready to launch on {chainName}?</Text>
      {checks.map((c) => (
        <Pressable key={c.text} onPress={() => !c.ok && goto(c.fix)} style={s.check}>
          <Text style={{ color: c.ok ? C.up : c.optional ? C.dim : C.down, fontWeight: '700' }}>{c.ok ? '✓' : c.optional ? '–' : '✕'}</Text>
          <Text style={[T.body, { flex: 1 }]}>{c.text}</Text>
          {!c.ok && <Text style={s.link}>Fix ›</Text>}
        </Pressable>
      ))}
      <View style={s.summary}>
        <Text style={T.meta}>{form.name} ({form.symbol}) · {draft.items.toLocaleString()} NFTs · {draft.royaltyBps / 100}% creator earnings</Text>
        {draft.phases.map((p, i) => (
          <Text key={i} style={T.caption}>
            {p.name}: {Number(p.price) === 0 ? 'free' : `${p.price} ${config.chains.find((c) => c.id === draft.chain)?.native ?? 'ETH'}`}
            {p.maxPerWallet ? `, ${p.maxPerWallet} per ${p.members ? 'account' : 'wallet'}` : ''}{p.members ? ', FloorFeed members' : p.allowlist ? `, ${(draft.allowlists[i] ?? 0).toLocaleString()} wallets` : ', public'}
            {` · from ${new Date(p.start * 1000).toLocaleString()}`}
          </Text>
        ))}
      </View>

      {!draft.metaCid ? (
        <Button label={busy ?? 'Prepare metadata'} onPress={prepare} disabled={!ready || !!busy} />
      ) : !w.address ? (
        <View style={{ gap: 8 }}>
          <Text style={T.meta}>Connect the wallet that will own the collection. It pays the network fee to launch and receives the mint money.</Text>
          {w.available.map((o) => <Button key={o.name} tone="secondary" label={`Connect ${o.name}`} onPress={() => w.connect(o.name)} />)}
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          <Text style={T.caption}>Metadata pinned. Launching from {w.address.slice(0, 6)}…{w.address.slice(-4)}, which will own the contract.</Text>
          <Button label={busy ?? `Launch on ${chainName}`} onPress={launch} disabled={!!busy} />
          <Pressable onPress={prepare} disabled={!!busy}><Text style={s.link}>Re-pin metadata (after changing art or details)</Text></Pressable>
        </View>
      )}
      {err && <Text style={s.err}>{err}</Text>}
      <Text style={T.caption}>After launch the art, supply and allowlists are fixed (supply can only be lowered). You can still change phase dates and prices, reveal, and withdraw.</Text>
    </Card>
  );
}

// --- Manage (live) ---

function Manage({ draft, userId, config }: { draft: LaunchDraft; userId: string; config: LaunchConfig }) {
  const w = useEvmWallet();
  const [c, setC] = useState<LaunchedCollection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    if (draft.address) api.launched(draft.chain, draft.address).then(setC).catch(() => {});
  }, [draft.chain, draft.address]);
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, [load]);

  const act = async (action: 'reveal' | 'withdraw' | 'freeze', label: string) => {
    if (!w.address || !w.send) return;
    setBusy(label);
    setMsg(null);
    try {
      const tx = await api.launchManageTx(userId, draft.id, action);
      if (tx.owner !== w.address.toLowerCase()) throw new Error(`Only the owner wallet (${tx.owner.slice(0, 6)}…${tx.owner.slice(-4)}) can do that.`);
      const hash = await w.send({ ...tx, description: `${label} · ${draft.name}` });
      setMsg(`${label}: sent. It confirms in a minute.`);
      recordTx({ hash, wallet: w.address, chain: draft.chain, kind: 'mint', title: `${label} · ${draft.name}`, amount: null, unit: null });
      setTimeout(load, 8000);
    } catch (e) {
      const m = (e as Error).message;
      setMsg(/reject|denied|cancel/i.test(m) ? 'Cancelled in your wallet.' : m);
    } finally {
      setBusy(null);
    }
  };
  const url = `https://floorfeed.io/c/${draft.chain}/${draft.address}`;
  return (
    <Card style={{ gap: 14 }}>
      <Text style={[T.title, { color: C.up }]}>Live on {config.chains.find((x) => x.id === draft.chain)?.name ?? draft.chain}</Text>
      {c ? (
        <>
          <View style={s.bar}><View style={[s.fill2, { width: `${Math.min(100, (c.minted / Math.max(1, c.max)) * 100)}%` }]} /></View>
          <Text style={T.metaNum}>{c.minted.toLocaleString()} / {c.max.toLocaleString()} minted{c.revealed ? ' · revealed' : ''}</Text>
        </>
      ) : <ActivityIndicator color={C.accent} />}
      <Button label="Open the mint page" onPress={() => router.push({ pathname: '/c/[chain]/[address]', params: { chain: draft.chain, address: draft.address! } })} />
      <Text style={T.caption} selectable>Share: {url}</Text>
      {!w.address ? <Text style={T.meta}>Connect the owner wallet to reveal or withdraw.</Text> : (
        <View style={{ gap: 8 }}>
          <Button tone="secondary" label={busy === 'Withdraw' ? 'Withdrawing…' : 'Withdraw mint earnings'} onPress={() => act('withdraw', 'Withdraw')} disabled={!!busy} />
          {c && !c.revealed && <Button tone="secondary" label={busy === 'Reveal' ? 'Revealing…' : 'Reveal the art'} onPress={() => act('reveal', 'Reveal')} disabled={!!busy} />}
          {c?.revealed && <Button tone="secondary" label={busy === 'Freeze' ? 'Freezing…' : 'Freeze metadata forever'} onPress={() => act('freeze', 'Freeze')} disabled={!!busy} />}
        </View>
      )}
      {msg && <Text style={T.meta}>{msg}</Text>}
      <Text style={T.caption}>Reveal after the mint ends: revealing early lets people see which art the next numbers get. Contract: {draft.address}</Text>
      <Pressable onPress={() => Linking.openURL(`${c?.explorer ?? ''}/address/${draft.address}`)}><Text style={s.link}>View on explorer ↗</Text></Pressable>
    </Card>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  page: { width: '100%', maxWidth: 820, alignSelf: 'center', paddingTop: 20, paddingBottom: 120, gap: 16 },
  crumb: { ...T.label, color: C.dim },
  tabs: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 14, borderWidth: 1, borderColor: C.border, backgroundColor: C.card, flexWrap: 'wrap' },
  tab: { flexGrow: 1, alignItems: 'center', paddingVertical: 9, paddingHorizontal: 8, borderRadius: 10 },
  tabOn: { backgroundColor: C.cardHi },
  tabTxt: { ...T.label, color: C.dim },
  input: { backgroundColor: C.bg, borderRadius: 10, borderWidth: 1, borderColor: C.border, color: C.text, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  imgPick: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  thumb: { width: 56, height: 56, borderRadius: 10, overflow: 'hidden', backgroundColor: C.cardHi, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { width: 92, gap: 3 },
  cellImg: { width: 92, height: 92, borderRadius: 8, backgroundColor: C.cardHi },
  bar: { height: 8, borderRadius: 4, backgroundColor: C.cardHi, overflow: 'hidden' },
  fill2: { height: 8, borderRadius: 4, backgroundColor: C.accent },
  phase: { gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.border },
  smallBtn: { alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardHi },
  check: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  summary: { gap: 4, padding: 12, borderRadius: 12, backgroundColor: C.cardHi },
  link: { ...T.label, color: C.accent },
  err: { ...T.meta, color: C.down },
  warn: { ...T.meta, color: C.accent },
});
