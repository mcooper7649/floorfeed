import type { Chain } from '@/lib/api';

// Every chain FloorFeed shows. EVM entries carry what a browser wallet needs
// to add the network if it doesn't know it yet (wallet_addEthereumChain).
export const CHAINS: Record<Chain, { name: string; badge: string; id?: number; explorer?: string; rpc?: string; symbol?: string }> = {
  solana: { name: 'Solana', badge: 'SOL' },
  ethereum: { name: 'Ethereum', badge: 'ETH', id: 1, explorer: 'https://etherscan.io', rpc: 'https://ethereum-rpc.publicnode.com' },
  base: { name: 'Base', badge: 'BASE', id: 8453, explorer: 'https://basescan.org', rpc: 'https://mainnet.base.org' },
  abstract: { name: 'Abstract', badge: 'ABS', id: 2741, explorer: 'https://abscan.org', rpc: 'https://api.mainnet.abs.xyz' },
  ink: { name: 'Ink', badge: 'INK', id: 57073, explorer: 'https://explorer.inkonchain.com', rpc: 'https://rpc-gel.inkonchain.com' },
  arbitrum: { name: 'Arbitrum', badge: 'ARB', id: 42161, explorer: 'https://arbiscan.io', rpc: 'https://arb1.arbitrum.io/rpc' },
  polygon: { name: 'Polygon', badge: 'POL', id: 137, explorer: 'https://polygonscan.com', rpc: 'https://polygon-rpc.com', symbol: 'POL' },
  hyperevm: { name: 'HyperEVM', badge: 'HYPE', id: 999, explorer: 'https://hyperevmscan.io', rpc: 'https://rpc.hyperliquid.xyz/evm', symbol: 'HYPE' },
  ronin: { name: 'Ronin', badge: 'RON', id: 2020, explorer: 'https://app.roninchain.com', rpc: 'https://api.roninchain.com/rpc', symbol: 'RON' },
  apechain: { name: 'ApeChain', badge: 'APE', id: 33139, explorer: 'https://apescan.io', rpc: 'https://rpc.apechain.com/http', symbol: 'APE' },
  monad: { name: 'Monad', badge: 'MON', id: 143, explorer: 'https://monadscan.com', rpc: 'https://rpc.monad.xyz', symbol: 'MON' },
};

export const chainName = (c: string) => CHAINS[c as Chain]?.name ?? c;
export const chainById = (id: number) => Object.entries(CHAINS).find(([, v]) => v.id === id) as [Chain, (typeof CHAINS)[Chain]] | undefined;
// OpenSea asset URLs use its API chain names (Polygon is "matic", ApeChain "ape_chain").
export const openseaAsset = (chain: string, mint: string) =>
  `https://opensea.io/assets/${chain === 'polygon' ? 'matic' : chain === 'apechain' ? 'ape_chain' : chain}/${mint.replace(':', '/')}`;
