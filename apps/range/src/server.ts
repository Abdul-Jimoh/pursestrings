import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Route } from "@pursestrings/shop";
import { runAttempt } from "./agent.ts";
import { cost, type Limits, type Pricing } from "./limits.ts";
import type { ChatModel } from "./model.ts";
import { breached, type Store } from "./store.ts";

export const MAX_PROMPT_CHARS = 2_000;
const SESSION_MS = 24 * 3_600_000;
const NONCE_MS = 5 * 60_000;

export interface SignIn {
  accountId: string;
  publicKey: string;
  /** Base64, as wallets return it from NEP-413 `signMessage`. */
  signature: string;
  nonce: string;
}

export interface RangeDeps {
  model: ChatModel;
  tools: Client;
  limits: Limits;
  store: Store;
  pricing: Pricing;
  /** Accounts and addresses the policy may pay; anything else approved is a breach. */
  ours: readonly string[];
  /** Throws unless the NEP-413 signature over `message` is valid for the account. */
  verify(signIn: SignIn, message: string): Promise<void>;
  /** Shown to visitors: the account under attack and where to see it. */
  target: { account: string; explorer: string };
  publicDir?: string;
  /** Browser origins allowed to call the API, such as https://pursestrings.site; any if unset. */
  origins?: readonly string[];
  /** More API routes, such as the shop's; they see the signed-in account, if any. */
  routes?: readonly Route[];
  now?: () => number;
}

export const signInMessage = (nonce: string) => `Sign in to Pursestrings Range (${nonce})`;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_000) throw new Error("request too large");
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

export function rangeServer(d: RangeDeps) {
  const now = d.now ?? Date.now;
  const nonces = new Map<string, number>();
  const sessions = new Map<string, { account: string; until: number }>();
  let busy = false;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://range");
    const origin = req.headers.origin;
    if (!d.origins) res.setHeader("access-control-allow-origin", "*");
    else if (origin && d.origins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
    }
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    try {
      if (req.method === "GET" && url.pathname === "/api/status") {
        return send(res, 200, {
          ...d.limits.status(),
          target: d.target,
          attempts: d.store.all().length,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/log") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
        const before = Number(url.searchParams.get("before")) || Number.POSITIVE_INFINITY;
        const all = d.store.all();
        return send(res, 200, {
          entries: all
            .filter((e) => e.id < before)
            .slice(-limit)
            .reverse(),
          total: all.length,
          hallOfFame: all.filter((e) => e.breach),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/nonce") {
        const nonce = randomBytes(32).toString("base64");
        nonces.set(nonce, now() + NONCE_MS);
        return send(res, 200, {
          nonce,
          message: signInMessage(nonce),
          recipient: "pursestrings.site",
        });
      }
      if (req.method === "POST" && url.pathname === "/api/session") {
        const s = (await body(req)) as unknown as SignIn;
        const expires = nonces.get(s.nonce);
        nonces.delete(s.nonce);
        if (!expires || expires < now())
          return send(res, 400, { error: "unknown or expired nonce" });
        if (!/\.testnet$/.test(s.accountId ?? "")) {
          return send(res, 400, { error: "sign in with a NEAR testnet account" });
        }
        const valid = await d.verify(s, signInMessage(s.nonce)).then(
          () => true,
          () => false,
        );
        if (!valid) return send(res, 401, { error: "signature doesn't verify for that account" });
        const token = randomBytes(24).toString("hex");
        sessions.set(token, { account: s.accountId, until: now() + SESSION_MS });
        return send(res, 200, { token, account: s.accountId });
      }
      if (req.method === "POST" && url.pathname === "/api/attack") {
        const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        const session = sessions.get(auth);
        if (!session || session.until < now()) return send(res, 401, { error: "sign in first" });
        const { prompt } = await body(req);
        if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
          return send(res, 400, { error: `a prompt of 1 to ${MAX_PROMPT_CHARS} characters` });
        }
        const allowed = d.limits.check(session.account);
        if (!allowed.ok) return send(res, 429, { error: allowed.reason });
        // One attempt at a time keeps the agent key's nonce and the spend log in order.
        if (busy)
          return send(res, 429, {
            error: "the agent is busy with another attempt; try again shortly",
          });
        busy = true;
        try {
          const attempt = await runAttempt(prompt, d.model, d.tools);
          const costUsd = cost(attempt.usage, d.pricing);
          d.limits.record(session.account, costUsd, now());
          const entry = d.store.add({
            ...attempt,
            at: now(),
            account: session.account,
            prompt,
            costUsd,
            breach: breached(attempt, d.ours),
          });
          return send(res, 200, entry);
        } finally {
          busy = false;
        }
      }
      const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const signedIn = sessions.get(auth);
      for (const route of d.routes ?? []) {
        const out = await route({
          method: req.method ?? "GET",
          url,
          account: signedIn && signedIn.until >= now() ? signedIn.account : undefined,
          body: () => body(req),
        });
        if (out) return send(res, out.status, out.data);
      }
      if (req.method === "GET" && d.publicDir) {
        const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
        if (path.includes("..")) return send(res, 400, { error: "bad path" });
        const file = await readFile(join(d.publicDir, path)).catch(() => undefined);
        if (file) {
          res.writeHead(200, {
            "content-type": TYPES[extname(path)] ?? "application/octet-stream",
          });
          return res.end(file);
        }
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });
}
