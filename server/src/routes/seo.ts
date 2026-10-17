// SEO: Caddy sends page requests here as /seo/<path> (see seo.ts).
import type { FastifyInstance } from "fastify";
import { card, renderPage, robots, sitemap } from "../seo.ts";

export function seoRoutes(app: FastifyInstance) {
  app.get("/seo/robots.txt", async (_req, reply) => reply.type("text/plain").header("cache-control", "public, max-age=3600").send(robots()));
  app.get("/seo/sitemap.xml", async (_req, reply) => reply.type("application/xml").header("cache-control", "public, max-age=3600").send(sitemap()));
  app.get("/seo/og/:kind/:file", async (req, reply) => {
    const { kind, file } = req.params as { kind: string; file: string };
    const m = file.match(/^(.+)\.png$/);
    if (!m || (kind !== "collection" && kind !== "wallet")) return reply.code(404).send();
    const png = await card(kind, decodeURIComponent(m[1]));
    if (!png) return reply.code(404).send();
    return reply.type("image/png").header("cache-control", "public, max-age=1800").send(png);
  });
  app.get("/seo/*", async (req, reply) => {
    const path = "/" + ((req.params as { "*": string })["*"] ?? "");
    const { status, html } = await renderPage(path);
    return reply.code(status).type("text/html; charset=utf-8").header("cache-control", "public, max-age=60").send(html);
  });
}
