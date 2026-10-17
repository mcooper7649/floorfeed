import cors from "@fastify/cors";
import Fastify from "fastify";
import { ZodError } from "zod";
import { startAlerts } from "./alerts.ts";
import { startAdmin } from "./admin.ts";
import { startAnalytics } from "./analytics.ts";
import { COLLECTIONS, config } from "./config.ts";
import { smartMoney } from "./discover.ts";
import { loadDiscovered } from "./discovery.ts";
import { startIngest } from "./ingest.ts";
import { warmRarity } from "./items.ts";
import { startMints } from "./mints.ts";
import { startPracticeSeasons } from "./practice.ts";
import { refreshPrices } from "./prices.ts";
import { accountRoutes } from "./routes/account.ts";
import { adminRoutes } from "./routes/admin.ts";
import { evmRoutes, interactiveLane } from "./routes/evm.ts";
import { launchRoutes } from "./routes/launch.ts";
import { marketRoutes } from "./routes/market.ts";
import { mintRoutes } from "./routes/mints.ts";
import { seoRoutes } from "./routes/seo.ts";
import { socialRoutes } from "./routes/social.ts";
import { solanaRoutes } from "./routes/solana.ts";
import { takeRoutes } from "./routes/takes.ts";
import { walletRoutes } from "./routes/wallet.ts";
import { startNames } from "./sns.ts";
import { startSocial } from "./social.ts";

const app = Fastify({ logger: { level: "info" } });
await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PUT", "DELETE"] });
app.addHook("onRequest", interactiveLane);
// A failed zod parse in a route is bad input, not a server error: 400 with the
// first problem's message (the form error the app shows). Anything else goes
// on to Fastify's default handler.
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? "Check the form." });
  throw err;
});

// Routes live in routes/, one module per area.
marketRoutes(app);
takeRoutes(app);
accountRoutes(app);
solanaRoutes(app);
evmRoutes(app);
walletRoutes(app);
launchRoutes(app);
mintRoutes(app);
adminRoutes(app);
socialRoutes(app);
seoRoutes(app);

// INGEST=0 runs the API only. This machine and production share a public IP,
// and so Magic Eden's rate limit.
loadDiscovered(); // last run's discovered EVM collections, before anything reads the lists
if (process.env.INGEST !== "0") startIngest();
else { void refreshPrices(); setInterval(() => void refreshPrices(), 10 * 60_000).unref(); } // USD values for local dev
// Rank every Solana collection's items in the background (weekly refresh),
// starting after boot so it doesn't compete with the first polls.
if (process.env.INGEST !== "0") {
  const warm = () => void warmRarity(COLLECTIONS.map((c) => c.symbol));
  setTimeout(warm, 5 * 60_000).unref();
  setInterval(warm, 6 * 3_600_000).unref();
}
startSocial();
startPracticeSeasons();
startNames();
startAlerts();
startAnalytics();
startAdmin(); // reads bridge fees back from Relay
startMints();
// Smart-money holdings take a few seconds to compute: keep them warm.
setTimeout(() => smartMoney(), 60_000).unref();
setInterval(() => smartMoney(), 4 * 60_000).unref();
await app.listen({ host: "0.0.0.0", port: config.port });
