import { recordTx } from './activity';
import { api } from './api';
import type { EvmWalletState } from './wallet-types';

// Cancel an OpenSea listing: on OpenSea's signed zone the wallet signs the
// order hash (free, no gas); older orders need an on-chain Seaport cancel.
export async function cancelEvmListing(w: EvmWalletState, l: { chain: string; orderHash: string; name: string }) {
  if (!w.address) throw new Error('Connect your wallet first.');
  const c = await api.evmCancelBuild({ chain: l.chain, orderHash: l.orderHash, seller: w.address });
  if (c.kind === 'offchain') {
    if (!w.signTypedData) throw new Error("This wallet can't sign the cancel.");
    const signature = await w.signTypedData(c.typedData);
    await api.evmCancelSubmit({ chain: l.chain, protocolAddress: c.protocolAddress, orderHash: l.orderHash, signature, seller: w.address });
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
