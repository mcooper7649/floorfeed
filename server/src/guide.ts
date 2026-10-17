import { config } from "./config.ts";
import { launchConfig, MAX_ITEMS } from "./launch.ts";

// "How FloorFeed works": one source for the in-app guide (GET /guide) and the
// server-rendered /how-it-works page (seo.ts). Keep every claim true to the
// code: tier thresholds match feed.ts tierOf, fees match fees.ts, polling
// matches config.ts, the paper exit matches config.paperSellHaircut, bridging
// matches bridge.ts, buy/sell/approve match trade-evm.ts, mints match drops.ts
// and mints.ts, launching matches launch.ts and contracts/.
//
// Sections belong to one of three parts: the basics everyone needs, paper
// trading, and real trading. Screenshots live in app/public/guide/ (captured at
// 390px wide, 2x, with an illustrative demo wallet); `w`/`h` are their pixel
// sizes so pages can reserve the space before they load.

export type GuidePart = "basics" | "paper" | "real";
export type GuideBlock =
  | { p: string }
  | { list: { term: string; text: string }[] }
  | { steps: string[] }
  | { tip: string }
  | { img: string; alt: string; caption?: string; w: number; h: number };
export type GuideSection = { id: string; part: GuidePart; title: string; blocks: GuideBlock[] };

export const GUIDE_PARTS: { id: GuidePart; title: string; blurb: string }[] = [
  { id: "basics", title: "The basics", blurb: "The feed, the badges, profit after fees, alerts and finding collections." },
  { id: "paper", title: "Practice trading", blurb: "Practice with simulated money at live prices. No wallet, no sign-up." },
  { id: "real", title: "Real trading", blurb: "Your own wallet, real NFTs, and money that moves between networks." },
];

const minutes = Math.round(config.activityPollMs / 60_000);
// Networks the launchpad is deployed on (LAUNCH_CHAINS), as "Base, Robinhood Chain and Ethereum".
const names = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const launchNets = () => names(launchConfig().chains.map((c) => c.name)) || "a few networks";
const haircut = Math.round(config.paperSellHaircut * 100);
const img = (name: string, alt: string, w: number, h: number, caption?: string): GuideBlock =>
  ({ img: `/guide/${name}.webp`, alt, w, h, ...(caption ? { caption } : {}) });

export const GUIDE: GuideSection[] = [
  // --- the basics ---------------------------------------------------------------
  {
    id: "what",
    part: "basics",
    title: "What FloorFeed is",
    blocks: [
      { p: "A live feed of NFT trades from wallets with a track record, on Solana, Ethereum and 9 more chains. We read every sale in the collections we track, match each wallet's buys to its later sales, and score traders on what they actually made." },
      { p: "Use it to see who is buying right now, judge whether they're any good, and follow the ones who keep winning. When you want to act on a trade, you can practice with simulated money or trade for real with your own wallet. Once you're signed in or have a wallet connected, Real is the default; the Practice | Real switch is on the Portfolio tab." },
    ],
  },
  {
    id: "feed",
    part: "basics",
    title: "Reading the feed",
    blocks: [
      { list: [
        { term: "Buy", text: "A wallet bought an NFT. Notable buys come with a short AI take on the wallet and the price." },
        { term: "Flip", text: "A wallet sold an NFT it bought earlier. The number is its profit or loss after fees." },
        { term: "Sweep", text: "One wallet bought 3 or more from the same collection within 15 minutes." },
        { term: "Cluster", text: "3 or more different wallets bought the same collection within 6 hours." },
      ] },
      { p: "The feed has two tabs. Buys holds Buy, Sweep and Cluster cards, and each ends in Buy floor (practice or real, depending on your mode) with Offer beside it on Ethereum and its networks. Flips holds Flip cards, which end in \"See <collection>\": a flip is a sale, so the link opens the collection, where Buy floor is one tap away." },
      img("feed-flip-card", "A Win card on the Flips tab: a wallet flipped RobinPunks for +0.006 ETH (+$15) after fees, +43.5% in 14 hours, with a See RobinPunks button", 780, 656,
        "A flip card. The profit is after fees, and the button opens the collection."),
      { p: "On Buys, Top ranks the last 72 hours by who bought, how much and how recently (at most one card in three is a cluster), and Latest is every buy as it lands. On Flips, All is every flip and Profitable is +2% or more after fees. Filter by chain, switch to Following to see only the wallets you follow, and Hide bots (on by default) leaves out market-making wallets that trade around the clock." },
    ],
  },
  {
    id: "badges",
    part: "basics",
    title: "Trader badges",
    blocks: [
      { list: [
        { term: "Top Flipper", text: "15+ completed flips, a win rate around 68% or better, and in profit overall." },
        { term: "Proven", text: "5+ completed flips, a win rate around 60% or better, and in profit overall." },
        { term: "New", text: "Fewer than 2 completed flips we've seen. Not enough history to judge yet." },
        { term: "Market maker", text: "Most trades run through AMM pools (Solana) or nearly every buy is an accepted bid (Ethereum). These are liquidity bots, so they're hidden from rankings by default." },
      ] },
      { p: "Win rates are smoothed so a wallet with 2 lucky flips doesn't outrank one with 40. Badges only count trades in the collections FloorFeed tracks." },
    ],
  },
  {
    id: "fees",
    part: "basics",
    title: "Profit is after fees",
    blocks: [
      { p: "Every P&L on FloorFeed counts what the wallet really paid and received: marketplace fees and creator royalties come off each flip. For Solana we read the amounts from the transaction itself; when we can't, we use the marketplace's 2% fee plus the collection's royalty. On Ethereum and other chains the seller pays the collection's required OpenSea fees. Gas isn't counted." },
    ],
  },
  {
    id: "alerts",
    part: "basics",
    title: "Follow wallets and get alerts",
    blocks: [
      { p: "Tap Follow on any trader. Their buys and sales go to your Alerts inbox (the bell), and sales show the profit after fees. Turn on notifications to get a ping in your browser the moment they trade." },
      { p: `Followed Solana wallets are watched in real time, usually within seconds. Everything else updates every ${minutes} minutes or so. On iPhone, add FloorFeed to your Home Screen first; Safari only allows notifications for installed web apps.` },
    ],
  },
  {
    id: "discover",
    part: "basics",
    title: "Find collections",
    blocks: [
      { list: [
        { term: "Trending", text: "Today's trading volume against the collection's usual daily volume." },
        { term: "Smart money", text: "Collections that Top Flipper and Proven wallets bought in the last 30 days and still hold." },
        { term: "Breakouts", text: "The biggest 24-hour floor gains among collections with real volume. Thin markets can fall as fast as they rise." },
        { term: "Blue chips", text: "The collections with the most trading volume over 7 days." },
        { term: "Minting", text: "Drops that are minting now or opening soon, each with its own mint page." },
      ] },
      { p: "On a computer these lists live in the panel on the left. On a phone, the Markets tab lists every collection with its floor, volume and change, and lets you star the ones to watch. Every collection page has floor charts, the cheapest listings with rarity, and its best flippers. The Minting list there shows drops that are live or coming up." },
    ],
  },

  // --- paper ----------------------------------------------------------------------
  {
    id: "paper",
    part: "paper",
    title: "How practice trading works",
    blocks: [
      { p: "Practice mode uses simulated money at live prices. It needs no wallet and no sign-up, and it's what you get until you sign in or connect one. Practice is purple: the buy bar's border, its Buy button and the \"Practice\" marker next to the price. Your positions are kept on this device; sign in and they move to your account." },
      { steps: [
        "Find a buy you like on the feed's Buys tab and tap Buy floor (the bar says Practice in purple).",
        "FloorFeed records one NFT bought at that collection's current floor. A line under the button confirms the price you got.",
        "Open Portfolio to watch the position. Open positions are marked at what you'd get selling now.",
        "Tap Sell when you're done. The profit or loss is locked in, after fees.",
      ] },
      img("practice-copy-card", "A Cluster card on the Buys tab: 3 wallets bought Primates in 1 hour, including 2 proven flippers, ending in a purple-bordered buy bar: 0.247 SOL ($26), marked Practice, with a purple Buy floor button", 780, 846),
      img("practice-copied", "The same card after tapping Buy floor: a line under the bar reads Bought in practice at 0.247 SOL. See Portfolio.", 780, 214,
        "One tap: the fill price shows under the button."),
    ],
  },
  {
    id: "paper-pricing",
    part: "paper",
    title: "How practice prices and fees are counted",
    blocks: [
      { p: "Practice trades are built to come out the way a real trade would, so a practice win means something." },
      { list: [
        { term: "Buying", text: "One NFT fills at the collection's floor. On a collection page you can practice-buy ×3, ×5 or ×10 at once: that walks up the live listings, so the 2nd, 3rd and later items cost what they really would." },
        { term: "Fees on the buy", text: "The marketplace taker fee and the creator royalty are added on top of the price, like a real purchase." },
        { term: "Selling", text: `Sales go into the best bid, which sits below the floor, so a practice sale fills at the floor minus ${haircut}%, and the seller's fees come off that.` },
        { term: "Currencies", text: "Positions stay in the collection's own coin (SOL, ETH, HYPE, RON, APE or MON) and are totalled per coin. Collections priced in anything else are browse-only in practice." },
      ] },
      img("practice-portfolio", "Practice portfolio: practice profit and loss after fees, −0.242 SOL and −0.1009 ETH (about −$268 in total); the Top practice traders card (#1 of 5 this season); then open positions in Primates, Cambria Charters and Pudgy Penguins, each with its value in dollars, a Sell button, and how far the floor has to rise to break even", 780, 1726),
      { tip: "That small red number right after a buy is normal: fees, plus the gap between the floor and the bid. A practice position has to beat it to show a profit, just like a real one. Each open position shows how far the floor has to rise to break even, with a bar that fills as it gets there." },
      { p: "Reset (on the Positions header) clears every practice position, open and closed, for a fresh start. Practice trading is free and stays free." },
    ],
  },

  // --- real -----------------------------------------------------------------------
  {
    id: "wallets",
    part: "real",
    title: "Going real: your wallets",
    blocks: [
      { p: "Real mode uses your own wallet. Once you sign in or connect a wallet, Real is the default, and every real buy bar is lime green. You can switch back to Practice on the Portfolio tab." },
      { list: [
        { term: "Connect one you have", text: "Phantom, Solflare or Backpack for Solana; MetaMask, Rabby, Coinbase Wallet and other browser wallets for Ethereum and its networks." },
        { term: "Or get one with FloorFeed", text: "Sign in with email or Google and you get a Solana wallet and an Ethereum wallet, secured by Privy. Nothing to install." },
      ] },
      { p: "If you have both, a connected extension wins. The Portfolio shows the total across your wallets in dollars, each wallet with its balance, and Move and Deposit buttons." },
      img("real-wallet", "Real portfolio: $19.46 total across your wallets, in coins on 5 networks (0.0074 ETH and 10.012 APE), and an Ethereum wallet with Move and Deposit buttons", 780, 678),
    ],
  },
  {
    id: "networks",
    part: "real",
    title: "One address, many networks",
    blocks: [
      { p: "This is the part that trips people up. Your Ethereum wallet has one address, and that address works on every Ethereum-style network FloorFeed supports: Ethereum, Base, Abstract, Ink, Arbitrum, HyperEVM, Ronin, ApeChain, Monad and Robinhood Chain. But each network keeps its own balance. ETH on Ethereum can't pay for an NFT on Robinhood Chain until it's moved there." },
      { p: "Each network also has a coin that pays for its NFTs and its gas: ETH on Ethereum, Base, Abstract, Ink, Arbitrum and Robinhood Chain, HYPE on HyperEVM, RON on Ronin, APE on ApeChain and MON on Monad. Solana is separate again, with its own wallet and SOL." },
      { p: "\"Money by network\" on the Portfolio lists every network where you hold something, with its coin, any WETH, and the dollar value. Move on any row starts a transfer from there." },
      img("real-networks", "Money by network: Ink with ETH and WETH (Unwrap, Move, Send), Ethereum, Base, Robinhood Chain with ETH and WETH, and ApeChain with 10.01 APE, each in dollars; the networks without funds are listed under Other networks with an Add button", 780, 1840),
    ],
  },
  {
    id: "funding",
    part: "real",
    title: "Adding money",
    blocks: [
      { p: "Tap Deposit on a wallet. There are two ways in:" },
      { list: [
        { term: "Card or Apple Pay", text: "Buy SOL or ETH through MoonPay, right in FloorFeed. MoonPay handles the payment and any ID checks; the coins land in your wallet." },
        { term: "From an exchange or another wallet", text: "Copy the address or scan the QR code and send from Coinbase, Kraken, Phantom, MetaMask or anywhere else. The sheet watches your balance every few seconds and shows \"Received\" the moment it lands." },
      ] },
      { tip: "Sending from an exchange? Pick the network you plan to buy on (for example Base rather than Ethereum) and you'll skip the move later. If it lands on the wrong network, that's fine: move it in FloorFeed." },
    ],
  },
  {
    id: "real-buy",
    part: "real",
    title: "Buying for real",
    blocks: [
      { p: "Tap Buy floor on a feed card or a collection page. What happens next depends on the chain." },
      { p: "On Ethereum and its networks, the whole purchase happens in FloorFeed:" },
      { steps: [
        "FloorFeed finds the cheapest OpenSea listing priced in the network's coin and shows the NFT, its price in coin and dollars, and your balance on that network.",
        "It checks you can cover the price plus gas. Gas is estimated for a real purchase, including the extra data fee on networks like Base and Ink.",
        "It builds the purchase and runs it against the chain as you, without sending anything. A listing that just sold, or a balance that's short, shows up here instead of failing in your wallet and costing gas.",
        "Your wallet opens with the exact transaction. Nothing is sent until you confirm.",
        "The buy appears in Activity and is followed until it confirms. The NFT then shows up under Holdings.",
      ] },
      { p: "If you're short on that network, the sheet turns into two steps, Add and Buy, says how much more you need, and offers to move it for you. On networks with their own coin (HYPE, APE, RON, MON) it swaps your ETH or SOL into that coin on the way:" },
      img("real-buy-short", "Buy floor sheet for PiP & Friends #4831 at 0.436 HYPE ($34.33) on HyperEVM. Steps: 1 Add HYPE, 2 Buy. It says: Not enough HYPE on HyperEVM, and offers Get HYPE on HyperEVM, which swaps ETH from another network into HYPE. At the bottom: Practice instead and Cancel", 780, 1666),
      { p: "On Solana, the sheet shows the cheapest Magic Eden listing, what it costs and whether your SOL covers it, then the purchase finishes on Magic Eden. If you're short, Deposit opens with the shortfall filled in." },
      { tip: "Listings priced in wrapped coins (WETH and similar) need an extra approval, so FloorFeed only buys listings priced in the network's own coin. Real buys are one NFT at a time; sweeps are practice-only for now." },
    ],
  },
  {
    id: "bridging",
    part: "real",
    title: "Moving money between networks",
    blocks: [
      { p: "Moving (bridging) is how ETH on Ethereum becomes ETH on Robinhood Chain, or SOL becomes ETH on Base, without leaving FloorFeed. It runs on Relay, a bridge network: you send one deposit on the network you're leaving, and Relay's solvers pay you out on the other side from their own funds, usually within seconds. FloorFeed never holds the money; it only fetches the quote and checks the deposit." },
      { p: "Open it from Move on any wallet or network row, or let a buy or a mint open it for you with the right amount filled in." },
      { img: "/guide/bridge-flow.svg", alt: "Diagram: your wallet on Ethereum signs one deposit to Relay; a Relay solver sees it confirm and pays the same amount out to your wallet on Robinhood Chain from its own funds. FloorFeed only gets the quote, checks the deposit and follows it.", w: 720, h: 1080 },
      { steps: [
        "Pick where the money should go. From a buy or a mint, that's already set.",
        "Pick where it comes from. FloorFeed lists the networks where you have a balance and a wallet that can sign: the same coin first, then by what each balance is worth.",
        "Enter how much should arrive. FloorFeed asks Relay for an exact-output quote: the amount you type is what lands, and the fees are added to what you send.",
        "Read the quote: what you send, what you receive, Relay's fee, the network fee, and the expected time.",
        "Before the button appears, FloorFeed checks your balance and runs the deposit against the chain as you. A deposit that would fail is caught here.",
        "Confirm the one deposit in your wallet.",
      ] },
      img("real-bridge", "Get HYPE on HyperEVM: from Robinhood Chain, receive 0.4819 HYPE. You send 0.016030 ETH, bridge fee $0.12, FloorFeed fee $0.19, network fee under $0.01, arrives in seconds. Button: Swap 0.01603 ETH for 0.4819 HYPE", 780, 1466,
        "Opened from the buy above: the amount is the shortfall plus a cushion, swapped from ETH into HYPE."),
      { p: "After you confirm, the sheet follows the transfer through its stages: waiting for your deposit to confirm, delivering on the other network, then arrived. If it came from a buy or a mint, you go straight back to it with your new balance, ready to tap Buy." },
      img("real-bridge-moving", "Deposit confirmed. Delivering on Robinhood Chain, with a timer and a link to the deposit transaction", 780, 445),
      { list: [
        { term: "How long", text: "From Ethereum, usually 1–3 minutes: Relay waits for the deposit to confirm on mainnet first. Between faster networks, and from Solana, it's usually seconds. You can close the sheet; the money still arrives." },
        { term: "Why move a bit extra", text: "When a buy or a mint opens the transfer, it suggests a little more than you're short (10% of the price for a buy, 5% for a mint). Cheap listings sell fast, and if the cheapest goes while the money moves, the next one still fits. Whatever's left stays in your wallet on that network." },
        { term: "Changing coins", text: "Moving between networks with different coins is a swap and a transfer in one step: SOL to ETH on Base, or ETH to APE on ApeChain. The quote shows what arrives." },
        { term: "From Solana", text: "Relay hands FloorFeed the deposit as Solana instructions. FloorFeed assembles them into one transaction where your wallet is the only signer and pays the fee, checks it against the chain, and your Solana wallet signs it. These quotes expire after about a minute, so FloorFeed fetches a fresh one if you wait too long before confirming." },
        { term: "If something goes wrong", text: "If your deposit fails on the chain, nothing was moved and only the network fee was spent. If your wallet says it sent the deposit but it never reaches the chain, FloorFeed tells you after a minute and a half; nothing left your wallet. If Relay can't deliver, it refunds you on the network you sent from." },
      ] },
    ],
  },
  {
    id: "selling",
    part: "real",
    title: "Selling for real",
    blocks: [
      { p: "Holdings on the Portfolio lists your NFTs from tracked collections, valued at the estimated bid, with what you paid and your profit so far. Tap Sell on one." },
      { p: "On Ethereum and its networks you sell in FloorFeed, into the best offer on OpenSea for that NFT. That might be an offer on the item itself, on one of its traits, or on the whole collection; FloorFeed takes whichever pays most. The sheet shows the offer, the fees and royalty that come off it, and what you receive. If the offer is far below the floor, it says so, because that's usually a lowball bid." },
      { steps: [
        "The first time you sell from a collection, approve OpenSea to transfer NFTs from it. It's one transaction, needed once per collection.",
        "FloorFeed waits until the chain shows the approval, then the Sell button appears.",
        "Confirm the sale in your wallet. The NFT leaves and the payment arrives in the same transaction.",
      ] },
      { p: "Offers are paid in WETH, wrapped ETH (see the next section). On Solana, Sell opens the NFT on Magic Eden to finish there." },
    ],
  },
  {
    id: "offers",
    part: "real",
    title: "Making offers",
    blocks: [
      { p: "On Ethereum and its networks you can bid below the asking price. On an NFT's page, tap Make an offer, listed or not. From Buy floor, Make a collection offer bids on any NFT in the collection: whoever accepts first sells you one." },
      { p: "An offer is a signature, not a payment. No gas, and nothing leaves your wallet until someone accepts. The fees come out of your offer, so if it's accepted you pay exactly what you offered." },
      { steps: [
        "Offers are made in WETH. If you don't have enough, FloorFeed wraps the ETH you need first (one transaction).",
        "Once per network, allow OpenSea to use your WETH when an offer is accepted. Nothing is spent then.",
        "Sign the offer. It's on OpenSea right away, for 1 to 30 days.",
      ] },
      img("real-offer", "Collection offer on RobinPunks: 0.0126 WETH ($30.58), 10% under the floor, for 7 days. Price ideas against the floor and the best offer; the steps Get WETH and Allow WETH are ticked, and the button reads Step 3 of 3 · Sign offer for 0.0126 WETH", 780, 1850,
        "Steps 1 and 2 are already done for this wallet, so all that's left is the signature."),
      { p: "Your offers on the Portfolio (and the Offers tab of the Your NFTs panel) lists every live offer; Edit places a new price and cancels the old one, and cancelling is free. When an offer is accepted, FloorFeed tells you and the NFT appears in your holdings. History keeps every offer with its outcome: accepted, cancelled or expired. If your offer reaches the asking price, the sheet suggests buying instead, because that's instant." },
    ],
  },
  {
    id: "weth",
    part: "real",
    title: "WETH and unwrapping",
    blocks: [
      { p: "WETH is ETH in token form, always worth exactly 1 ETH. Offers on OpenSea are made in WETH, so money from a sale arrives as WETH. Plain wallet balances often don't show it, which can make it look like the sale paid nothing." },
      { p: "\"Money by network\" shows WETH next to the ETH on each network. Buys and gas need plain ETH, so tap Unwrap: one transaction turns the WETH back into the same amount of ETH, on the same network. You only pay gas, which is cents on Base, Ink and similar networks." },
    ],
  },
  {
    id: "minting",
    part: "real",
    title: "Minting drops",
    blocks: [
      { p: "The Mint tab lists drops across networks: live ones first, fastest-minting at the top, then upcoming stages by day, then what just ended. Each card shows how much of the supply is minted, how fast it's going (mints in the last 10 minutes and the last hour, read from the chain every 2 minutes) and how many proven flippers have minted. Filter by network and price. Verified only is on by default: it shows collections OpenSea has reviewed, and unverified drops (which can be copies) are one tap away." },
      { tip: "Upcoming stages have Remind me: FloorFeed sends a notification 5 minutes before the stage opens. Turn on notifications in your browser to get it." },
      { p: "Each drop has its own page with the art, every stage with its times, price and per-wallet limit, how much is minted and how fast." },
      { steps: [
        "Pick a quantity. The page shows the total and your coin balance on the drop's network.",
        "If you're short on that network, it says how much, and \"Move ETH to <network>\" opens a transfer with the shortfall plus a small cushion for gas.",
        "Tap Mint. OpenSea builds the mint transaction and FloorFeed runs it against the chain as you first. Allowlist stages are checked against your wallet here.",
        "Confirm in your wallet. Activity follows the mint, and the NFT appears in your real portfolio when it confirms.",
      ] },
      img("real-mint", "Mooncats drop on Robinhood Chain: minting now at 0.010 ETH, 255 of 4,444 minted, quantity 1, your ETH on Robinhood Chain 0.0012, Move ETH to Robinhood Chain", 780, 1000),
      { p: "Minting works in FloorFeed on every network it trades on, Robinhood Chain included. Drops on other networks, or stages priced in another token, get the same page and finish on OpenSea." },
    ],
  },
  {
    id: "launch",
    part: "real",
    title: "Launch your own collection",
    get blocks(): GuideBlock[] {
      return [
        { p: `Creators can launch a whole collection on FloorFeed: upload the art, set prices and mint phases, and launch from their own wallet on ${launchNets()}. Start from the Mint tab with "+ Launch a collection", on the website.` },
        { steps: [
          "Details: name, symbol, network, your earnings on resales (0 to 10%), whether the art is revealed after the mint or right away, and a cover, banner and placeholder image.",
          `Art: pick a folder of images numbered 1, 2, 3… (up to ${MAX_ITEMS.toLocaleString("en-US")}). Traits come from the JSON files most generators write next to each image (1.json), or from one CSV with a "file" column and a column per trait. You see a preview and how rare each trait is before uploading; the files go to IPFS.`,
          "Mint phases: up to four, each public, allowlist or FloorFeed members (anyone signed in, with a per-account limit the contract enforces), with its own start and end, price and limit. Paste allowlist wallets into the phase.",
          "Launch: a checklist, then FloorFeed pins your metadata and your wallet sends one transaction. That wallet owns the contract and pays only the network fee to launch.",
          "Manage: follow the mint, withdraw what you've earned any time, reveal when you're ready, and freeze the metadata for good.",
        ] },
        { p: "Collectors find new launches in the Launched on FloorFeed section at the top of the Mint tab. Each collection has a mint page with every phase, whether their wallet is on the list, and the total before they pay. If they're short on that network, Move tops them up. FloorFeed adds a small fee per NFT minted (0.0001 ETH), paid by the collector and shown before they mint; creators receive the full price they set." },
        { list: [
          { term: "Fair reveal", text: "With reveal after the mint, everyone sees a placeholder until the creator reveals. The reveal shuffles which artwork each token gets, so nobody, the creator included, can steer rare pieces to particular numbers. Reveal once the mint ends." },
          { term: "Fixed promises", text: "After launch the art and allowlists are set, supply can only be lowered, and the fee per NFT can never change. Prices and phase dates can still be adjusted." },
          { term: "Your contract", text: "The collection is a standard NFT contract owned by the creator's wallet. FloorFeed never holds the keys or the mint money, and every mint is checked against the contract before the collector's wallet sees it. Once it's out, the collection trades on OpenSea like any other." },
        ] },
      ];
    },
  },
  {
    id: "activity",
    part: "real",
    title: "Activity: did it go through?",
    blocks: [
      { p: "Every buy, sale, approval, transfer between networks, unwrap, mint and send you make in FloorFeed is logged in Activity on the Portfolio the moment your wallet hands back the transaction. FloorFeed then follows each one on the chain and updates it: Pending, Delivering (a transfer on its way to the other network), Confirmed, Failed, Dropped (never reached the chain) or Refunded. Every row links to the transaction on the network's explorer." },
      img("real-activity", "Activity list: an approval and two listings (one on ApeChain, one on Robinhood Chain, both active), a buy, a bridge from Ink to Robinhood Chain, an ApeChain buy and a bridge into APE, each confirmed", 780, 1144),
    ],
  },
  {
    id: "safety",
    part: "real",
    title: "Your keys stay yours",
    blocks: [
      { p: "FloorFeed never holds your keys, your funds or your NFTs. A connected wallet asks before signing anything, and the built-in wallet's key is secured by Privy, not by us. Every purchase, sale, mint and transfer is checked against the chain before your wallet sees it, so a failing transaction shows up before you pay gas." },
      { p: "Withdraw any time: Send moves SOL, ETH (or a network's own coin) or an NFT on Ethereum's networks from your FloorFeed wallet to any address, and Export hands you the wallet's key so you can open it in Phantom or MetaMask with everything in it. There are no holds or limits." },
    ],
  },

  // --- questions (basics) ---------------------------------------------------------
  {
    id: "faq",
    part: "basics",
    title: "Questions",
    blocks: [
      { list: [
        { term: "Is it free?", text: "Yes. Browsing, following, alerts and practice trading are free. Real trades pay the usual marketplace fees, royalties and network gas, transfers between networks pay Relay's fee, and minting a collection launched on FloorFeed includes a small FloorFeed fee, all shown before you confirm." },
        { term: "Can I launch my own NFTs?", text: "Yes, from the Mint tab: + Launch a collection. You need your art and a wallet with a little of the network's coin for the launch fee." },
        { term: "Why does a card say \"See …\" instead of Copy?", text: "It's a flip card: someone sold. Copy is on buy, sweep and cluster cards. Open the collection to buy its floor." },
        { term: "I have ETH but the buy says I don't.", text: "Your ETH is on a different network than the NFT. The buy sheet tells you where it is; tap Move to bring it over." },
        { term: "Where does the data come from?", text: "Public marketplace data from Magic Eden and OpenSea, Solana transactions via Helius, and coin prices from CoinGecko." },
        { term: "Which collections are tracked?", text: "40 Solana collections plus the busiest collections on each EVM chain, refreshed daily. Over 140 in total." },
        { term: "Is this financial advice?", text: "No. FloorFeed shows what wallets did. Past flips don't predict future ones, and NFTs can lose most of their value quickly." },
      ] },
    ],
  },
];

// The guide before images, steps and parts existed, for app builds that only
// know paragraphs and lists (GET /guide without ?v=2).
export const GUIDE_V1 = GUIDE.map(({ id, title, blocks }) => ({
  id, title,
  blocks: blocks.flatMap((b): ({ p: string } | { list: { term: string; text: string }[] })[] =>
    "steps" in b ? [{ list: b.steps.map((text, i) => ({ term: `Step ${i + 1}`, text })) }]
      : "tip" in b ? [{ p: b.tip }]
      : "img" in b ? []
      : [b]),
}));
