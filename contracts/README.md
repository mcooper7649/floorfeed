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
