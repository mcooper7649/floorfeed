import { api, type ActivityKind } from './api';
import { chainById } from '@/constants/chains';

// Note a transaction in the wallet's FloorFeed activity the moment the wallet
// returns its hash. The server then follows it to confirmed/failed/dropped.
// Never blocks or fails the flow that sent it.
type Entry = {
  hash: string; wallet: string; kind: ActivityKind; title: string;
  chain?: string; chainId?: number;
  amount?: number | null; unit?: string | null; symbol?: string | null; mint?: string | null;
  requestId?: string | null; toChain?: string | null;
};

export function recordTx(e: Entry) {
  const chain = e.chain ?? (e.chainId != null ? chainById(e.chainId)?.[0] : undefined);
  if (!chain || !/^0x[0-9a-fA-F]{64}$/.test(e.hash)) return;
  const { chainId: _ignored, ...rest } = e;
  api.recordActivity({ ...rest, chain }).catch(() => {});
  window.dispatchEvent?.(new Event('floorfeed:activity'));
}
