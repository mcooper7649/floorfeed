# Wallets and real buys

FloorFeed is moving from paper trading to real purchases. This is the plan,
what already works, and what each next step needs.

**Decisions (October 2026):** web first; both wallet types (connect an existing
wallet, and Privy embedded wallets for newcomers); buy from both Magic Eden and
Tensor.

## Status

| Step | State |
|---|---|
| Connect Phantom, Solflare, Backpack (web, Wallet Standard) | Done |
| SOL balance via the server (`GET /chain/balance/:address`) | Done |
| `GET /capabilities`: which buy sources are configured | Done |
| `POST /trade/buy-tx` | Stub: returns 501 until a marketplace key is set |
| Privy sign-in (email, Google) with an embedded Solana wallet (web) | Done |
| Server verifies Privy access tokens; first sign-in moves the device's follows and paper trades to the account | Done |
| Helius RPC for balances (and later simulation) | Done |
| Magic Eden buys | Needs a Magic Eden API key |
| Tensor buys | Needs a Tensor API key |
| Android (Mobile Wallet Adapter), iOS | After web |

## Custody model

FloorFeed never holds keys or funds.

- **Connected wallets:** the app only learns the public address. Every
  transaction is shown and signed inside the user's wallet.
- **Privy wallets:** Privy creates and secures the key (split key shares); the
  user signs in with email or a social account. FloorFeed still never sees the key.

## How a buy will work

1. The user taps **Buy** on a listing (collection page grid or "Copy · buy floor").
2. The app asks the server for an unsigned transaction: `POST /trade/buy-tx`
   `{ buyer, mint, marketplace, expectedPrice }`.
3. The server re-reads the listing (price, seller, still active), then calls the
   marketplace's transaction-building API **with the key kept server-side**.
4. The server simulates the transaction against mainnet
   (`simulateTransaction` with the buyer account) and returns it with the
   simulated SOL change for the buyer.
5. The app shows a confirmation sheet: the NFT's art, name and rarity, listing price, marketplace
   fee, creator royalty, network fee, and **total SOL leaving the wallet**.
6. The wallet signs (and sends, via `solana:signAndSendTransaction` where
   supported). The app waits for confirmation and records the trade.

### Safety checks (all required before a real buy ships)

- **Price guard:** reject if the listing price moved above `expectedPrice`.
- **Spend guard:** the simulated SOL outflow must be at most
  price + listed fees + a small buffer for the network fee. Otherwise the
  server refuses to return the transaction.
- **Fee payer and signer check:** the only signer requested from the user is
  the connected address.
- **Per-transaction cap:** a user-set maximum (default 1 SOL), editable in the
  wallet sheet.
- **Kill switch:** `TRADING_ENABLED=false` on the server disables buying instantly.
- **Separate ledger:** real trades go to their own table and show separately
  from paper positions in Portfolio.
- **Testing:** marketplace listings only exist on mainnet. The first live test
  uses a collection with a floor of around 0.01–0.05 SOL.

## Keys you need to get

Put each one in the homelab's `~/floorfeed/server/.env` (or the app's env
where noted), then redeploy. None of them belong in git.

| Key | Where | Goes in | Unlocks |
|---|---|---|---|
| Magic Eden API key | Magic Eden developer docs → API key request form | `MAGICEDEN_API_KEY` (server) | Buy transactions for Magic Eden listings; also higher rate limits for all data |
| Tensor API key | Tensor developer portal | `TENSOR_API_KEY` (server) | Buy transactions for Tensor listings; collection bids (real instant-sell prices) |
| Privy app (have it) | dashboard.privy.io → new app (Solana embedded wallets on; allowed domains = the site + `http://localhost:8081`) | `EXPO_PUBLIC_PRIVY_APP_ID` (app); `PRIVY_APP_ID`, `PRIVY_APP_SECRET` (server) | Email/Google login with a wallet created for the user |
| Helius (have it) | dashboard.helius.dev (free tier) | `HELIUS_API_KEY`, `SOLANA_RPC_URL` (server) | Reliable sends, simulation and confirmations; webhooks per followed wallet |

## Order of work

1. **Now:** wallet connect + balances on web (done).
2. **When the Magic Eden key arrives:** buy-tx builder + simulation + safety
   checks, the confirmation sheet, and a real-trades ledger. Test with one cheap buy.
3. **Tensor key:** add Tensor as a second source and pick the cheaper listing.
4. **Privy (done on web):** "Continue with email or Google" above the detected wallets.
5. **Native:** Android via Mobile Wallet Adapter (EAS dev build), then iOS
   via Privy or Phantom deep links.

## How sign-in works

- **Anonymous by default.** Each device gets a `dev-…` id; follows and paper
  trades work without an account.
- **Signing in** (Privy: email or Google) gives the user a `did:privy:…` id and,
  if they have no wallet yet, an embedded Solana wallet. On the first sign-in
  the app calls `POST /auth/session` with its device id, and the server moves
  that device's follows and paper positions to the account.
- **The server checks every request for a Privy id**: it must carry that user's
  access token (`Authorization: Bearer …`), an ES256 JWT verified against
  Privy's JWKS (issuer `privy.io`, audience = app id). Requests for device ids
  stay unauthenticated, as before.
- **Bundle size.** Privy's SDK is several MB, so it is built on its own with
  esbuild (`app/privy/entry.tsx` → `app/public/privy/`, `npm run privy`) and
  fetched only when someone taps Sign in, or on load for a returning signed-in
  user. It renders in its own React root and reports state to the app. Build
  the site with `npm run build:web`, which builds this bundle first and passes
  its file name to the app as `EXPO_PUBLIC_PRIVY_ENTRY`.
- **Native** builds don't have sign-in yet (`lib/auth.tsx` is a stub); the Privy
  Expo SDK needs a client ID and a dev build.
