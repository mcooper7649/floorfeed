# FloorFeed launchpad contracts

- `FloorFeedDrop` — a creator's PFP collection (ERC-721 + ERC-2981 + ERC-4906), cloned per launch. Phases (allowlist via Merkle root / public) with price, window and per-wallet limit; FloorFeed fee per token fixed at creation; supply can only shrink; hidden → reveal with a random starting offset; freeze; IPFS (`baseURI + index + .json`) or on-chain metadata in `FloorFeedStore`. `mint(to, phase, qty, proof)`: anyone can pay, allowlist and limits apply to `to`.
- `FloorFeedFactory` — CREATE2 clones; the caller owns the collection; owner sets the fee for future launches.
- `FloorFeedStore` — SSTORE2 file store (from Shuin).

Setup: `lib/` is gitignored. Fetch the pinned versions:

```
git clone --depth 1 -b v1.17.0 https://github.com/foundry-rs/forge-std lib/forge-std
git clone https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts && git -C lib/openzeppelin-contracts checkout cab19933c33c2ad1d4c7a84864a3601dddfd16f3
git clone --depth 1 -b v5.7.0 https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable lib/openzeppelin-contracts-upgradeable
```

Test: `forge test`. Deploy (same addresses on every chain via the CREATE2 deployer):
`FF_OWNER=<owner> FF_FEE_TO=<fee wallet> FF_FEE=<wei per token> forge script script/Deploy.s.sol --rpc-url <rpc> --account <keystore> --broadcast`.
Fork smoke test: `forge script script/Smoke.s.sol --sig "run(address)" <factory> --rpc-url <fork> --broadcast`.

## Deployments (2026-10-16)

Same addresses on every chain (CREATE2, salt `floorfeed.launchpad.v1`, constructor owner = deployer, then ownership transferred):

| Contract | Address |
|---|---|
| FloorFeedStore | `0xF1656b4145982eE90bc9C4A96F5ba7044B1C83aa` |
| FloorFeedFactory (v2, fee exemptions) | `0x0E8b96866119a7B75dDB63b7F1ba722FC7a5F46d` |
| FloorFeedDrop (implementation, v2 factory) | `0x3E11C21809fB774563b5dc5329c5d93073D8c768` |
| FloorFeedFactory v1 (retired, no fee exemptions) | `0xcF7908632ce0adeeC1CE5c445BF85ae38B5b9A4E` (impl `0xE3eD3Ac4aC7B1BFc1201541e3344f010AFf26976`) |

Live on Ethereum (1), Base (8453), Robinhood Chain (4663). Fee 0.0001 ETH per token to the FloorFeed fee wallet; factory owner = FloorFeed fee wallet, which is also fee-exempt (`setFeeExempt`, `feeOf`). Deploy with `FF_EXEMPT` / `FF_FINAL_OWNER` to set both in one run. Sourcify-verified on Ethereum and Base (Robinhood's Blockscout API sits behind a Cloudflare challenge). To add a chain: fund the deployer there, run Deploy.s.sol with `FF_OWNER=<deployer>` (keeps the address), set its fee, transfer ownership, add the chain to `LAUNCH_CHAINS`. Base mainnet test collection (v1 factory): `0xbc013217988891d1a526d156a836bbbf0e7bdb4c` (3 items, 1 minted, revealed).
