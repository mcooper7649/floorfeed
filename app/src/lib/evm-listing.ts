import { recordTx } from './activity';
import { api } from './api';
import type { EvmWalletState } from './wallet-types';

// Cancel an OpenSea listing: on OpenSea's signed zone the wallet signs the
// order hash (free, no gas); older orders need an on-chain Seaport cancel.
export async function cancelEvmListing(w: EvmWalletState, l: { chain: string; orderHash: string; name: string; mint?: string }) {
  if (!w.address) throw new Error('Connect your wallet first.');
  const c = await api.evmCancelBuild({ chain: l.chain, orderHash: l.orderHash, seller: w.address });
  if (c.kind === 'offchain') {
    if (!w.signTypedData) throw new Error("This wallet can't sign the cancel.");
    const signature = await w.signTypedData(c.typedData);
    await api.evmCancelSubmit({ chain: l.chain, protocolAddress: c.protocolAddress, orderHash: l.orderHash, signature, seller: w.address });
    if (l.mint) announceListing(l.mint, null);
  } else {
    if (!w.send) throw new Error("This wallet can't send the cancel.");
    const hash = await w.send({ ...c.tx, description: 'Cancel your OpenSea listing (network fee only).' });
    recordTx({ hash, wallet: w.address, chain: l.chain, kind: 'approve', title: `Cancelled listing of ${l.name}` });
  }
}

export const daysLeft = (expiresAt: number) => {
  const d = (expiresAt * 1000 - Date.now()) / 86_400_000;
  return d >= 1 ? `${Math.floor(d)} day${Math.floor(d) === 1 ? '' : 's'} left` : `${Math.max(1, Math.round(d * 24))}h left`;
};

// Listing and cancelling aren't transactions, so they don't show up through
// Activity: tell the page (panel, Your listings, holdings) directly. `listing`
// is the new listing, or null when it was cancelled.
export type ListingChange = { mint: string; listing: { price: number; expiresAt: number; orderHash: string } | null; at: number };
export function announceListing(mint: string, listing: ListingChange['listing']) {
  const detail: ListingChange = { mint: mint.toLowerCase(), listing, at: Date.now() };
  globalThis.dispatchEvent?.(new CustomEvent('floorfeed:listing', { detail }));
}
