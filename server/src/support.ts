import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { tg } from "./social.ts";

// "Report a problem": the app's support form. Reports land in SQLite and are
// relayed to the admin Telegram chat; the admin lists them at GET
// /admin/support and closes them with POST /admin/support/:id/close.

db.exec(`
CREATE TABLE IF NOT EXISTS support_reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  topic      TEXT NOT NULL,
  message    TEXT NOT NULL,
  contact    TEXT,
  tx         TEXT,
  wallets    TEXT,             -- JSON string[]
  user_id    TEXT,
  page       TEXT,
  mode       TEXT,
  ua         TEXT,
  status     TEXT NOT NULL DEFAULT 'open'
);
`);

export const TOPICS = ["bug", "trade", "wallet", "idea", "other"] as const;
const TOPIC_LABEL: Record<(typeof TOPICS)[number], string> = {
  bug: "Bug", trade: "Trade / transfer", wallet: "Wallet / sign-in", idea: "Idea", other: "Other",
};

export const ReportBody = z.object({
  topic: z.enum(TOPICS),
  message: z.string().trim().min(10, "Tell us a little more (10+ characters).").max(4000),
  contact: z.string().trim().max(200).optional(),
  tx: z.string().trim().max(300).optional(),
  wallets: z.array(z.string().max(100)).max(4).optional(),
  userId: z.string().max(100).optional(),
  page: z.string().max(300).optional(),
  mode: z.enum(["paper", "real"]).optional(),
});

export class SupportError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// 5 reports per IP per hour keeps the chat usable if someone spams the form.
const hits = new Map<string, number[]>();
const clientIp = (req: FastifyRequest) =>
  String(req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? req.ip).split(",")[0].trim();

export async function submitReport(req: FastifyRequest, raw: unknown) {
  const parsed = ReportBody.safeParse(raw);
  if (!parsed.success) throw new SupportError(parsed.error.issues[0]?.message ?? "Check the form and try again.");
  const b = parsed.data;
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 5) throw new SupportError("You've sent a few reports already. Try again in an hour.", 429);
  hits.set(ip, [...recent, now]);

  const ua = String(req.headers["user-agent"] ?? "").slice(0, 300);
  const id = Number(db.prepare(`
    INSERT INTO support_reports (created_at, topic, message, contact, tx, wallets, user_id, page, mode, ua)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(now, b.topic, b.message, b.contact || null, b.tx || null, b.wallets?.length ? JSON.stringify(b.wallets) : null,
    b.userId ?? null, b.page ?? null, b.mode ?? null, ua).lastInsertRowid);

  if (config.telegramBotToken && config.telegramChatId) {
    const lines = [
      `Support #${id}: ${TOPIC_LABEL[b.topic]}${b.mode ? ` (${b.mode} mode)` : ""}`,
      "",
      b.message,
      "",
      b.contact ? `Reply to: ${b.contact}` : "No contact given",
      b.tx ? `Tx: ${b.tx}` : null,
      b.wallets?.length ? `Wallets: ${b.wallets.join(", ")}` : null,
      b.page ? `From: ${b.page}` : null,
      ua ? `Device: ${ua.slice(0, 120)}` : null,
    ].filter((l) => l != null);
    await tg("sendMessage", { chat_id: config.telegramChatId, text: lines.join("\n").slice(0, 4000), link_preview_options: { is_disabled: true } })
      .catch((err) => console.warn("[support] telegram:", (err as Error).message));
  }
  return { ok: true, id };
}

type Row = { id: number; created_at: number; topic: string; message: string; contact: string | null; tx: string | null;
  wallets: string | null; user_id: string | null; page: string | null; mode: string | null; ua: string | null; status: string };

export function listReports(status: "open" | "closed" | "all", limit: number) {
  const rows = (status === "all"
    ? db.prepare(`SELECT * FROM support_reports ORDER BY id DESC LIMIT ?`).all(limit)
    : db.prepare(`SELECT * FROM support_reports WHERE status = ? ORDER BY id DESC LIMIT ?`).all(status, limit)) as Row[];
  return rows.map((r) => ({ ...r, wallets: r.wallets ? (JSON.parse(r.wallets) as string[]) : [] }));
}

export function setReportStatus(id: number, status: "open" | "closed") {
  if (!db.prepare(`UPDATE support_reports SET status = ? WHERE id = ?`).run(status, id).changes) throw new SupportError("Not found.", 404);
  return { ok: true };
}
