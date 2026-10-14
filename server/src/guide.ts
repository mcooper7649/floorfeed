import { config } from "./config.ts";

// "How FloorFeed works": one source for the in-app guide (GET /guide) and the
// server-rendered /how-it-works page (seo.ts). Keep every claim true to the
// code: tier thresholds match feed.ts tierOf, fees match fees.ts, polling
// matches config.ts.

export type GuideBlock = { p: string } | { list: { term: string; text: string }[] };
export type GuideSection = { id: string; title: string; blocks: GuideBlock[] };

const minutes = Math.round(config.activityPollMs / 60_000);

export const GUIDE: GuideSection[] = [
  {
    id: "what",
    title: "What FloorFeed is",
    blocks: [
      { p: "A live feed of NFT trades from wallets with a track record, on Solana, Ethereum and 9 more chains. We read every sale in the collections we track, match each wallet's buys to its later sales, and score traders on what they actually made." },
      { p: "Use it to see who is buying right now, judge whether they're any good, and follow the ones who keep winning." },
    ],
  },
  {
    id: "feed",
    title: "Reading the feed",
    blocks: [
      { list: [
        { term: "Buy", text: "A wallet bought an NFT. Notable buys come with a short AI take on the wallet and the price." },
        { term: "Flip", text: "A wallet sold an NFT it bought earlier. The number is its profit or loss after fees." },
        { term: "Sweep", text: "One wallet bought 3 or more from the same collection within 15 minutes." },
        { term: "Cluster", text: "3 or more different wallets bought the same collection within 6 hours." },
      ] },
      { p: "Top ranks the last 72 hours by who traded, how much and how recently. Latest is every trade as it lands. Wins is profitable flips only. Filter by chain, or switch to Following to see only the wallets you follow." },
    ],
  },
  {
    id: "badges",
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
    title: "Profit is after fees",
    blocks: [
      { p: "Every P&L on FloorFeed counts what the wallet really paid and received: marketplace fees and creator royalties come off each flip. For Solana we read the amounts from the transaction itself; when we can't, we use the marketplace's 2% fee plus the collection's royalty. On Ethereum and other chains the seller pays the collection's required OpenSea fees. Gas isn't counted." },
    ],
  },
  {
    id: "alerts",
    title: "Follow wallets and get alerts",
    blocks: [
      { p: "Tap Follow on any trader. Their buys and sales go to your Alerts inbox (the bell), and sales show the profit after fees. Turn on notifications to get a ping in your browser the moment they trade." },
      { p: `Followed Solana wallets are watched in real time, usually within seconds. Everything else updates every ${minutes} minutes or so. On iPhone, add FloorFeed to your Home Screen first; Safari only allows notifications for installed web apps.` },
    ],
  },
  {
    id: "discover",
    title: "Find collections",
    blocks: [
      { list: [
        { term: "Trending", text: "Today's trading volume against the collection's usual daily volume." },
        { term: "Smart money", text: "Collections that Top Flipper and Proven wallets bought in the last 30 days and still hold." },
        { term: "Breakouts", text: "The biggest 24-hour floor gains among collections with real volume. Thin markets can fall as fast as they rise." },
        { term: "Blue chips", text: "The collections with the most trading volume over 7 days." },
      ] },
      { p: "On a computer these lists live in the panel on the left. On a phone, the Markets tab lists every collection with its floor, volume and change, and lets you star the ones to watch. Every collection page has floor charts, the cheapest listings with rarity, and its best flippers." },
    ],
  },
  {
    id: "paper",
    title: "Paper first, real when you're ready",
    blocks: [
      { p: "Paper mode is practice with simulated money: tap Copy on any trade to buy that collection's floor on paper, then sell later and see how you'd have done. Fees are counted like a real trade. No wallet or sign-up needed." },
      { p: "Real mode uses your own wallet: connect Phantom, Solflare or Backpack on Solana, or MetaMask and other browser wallets on Ethereum chains. No wallet? Sign in with email or Google and you get one. Ethereum-chain purchases happen right in FloorFeed; Solana purchases open on Magic Eden for now. Add funds with a card or by sending from an exchange." },
    ],
  },
  {
    id: "safety",
    title: "Your keys stay yours",
    blocks: [
      { p: "FloorFeed never holds your keys, your funds or your NFTs. A connected wallet asks before signing anything, and the built-in wallet's key is secured by Privy, not by us. Before you sign an Ethereum purchase, we simulate it so a failing transaction shows up before you pay gas." },
      { p: "Withdraw any time: Send moves SOL, ETH or an Ethereum-chain NFT from your FloorFeed wallet to any address, and Export hands you the wallet's key so you can open it in Phantom or MetaMask with everything in it. There are no holds or limits." },
    ],
  },
  {
    id: "faq",
    title: "Questions",
    blocks: [
      { list: [
        { term: "Is it free?", text: "Yes. Browsing, following, alerts and paper trading are free." },
        { term: "Where does the data come from?", text: "Public marketplace data from Magic Eden and OpenSea, Solana transactions via Helius, and coin prices from CoinGecko." },
        { term: "Which collections are tracked?", text: "40 Solana collections plus the busiest collections on each EVM chain, refreshed daily. Over 140 in total." },
        { term: "Is this financial advice?", text: "No. FloorFeed shows what wallets did. Past flips don't predict future ones, and NFTs can lose most of their value quickly." },
      ] },
    ],
  },
];
