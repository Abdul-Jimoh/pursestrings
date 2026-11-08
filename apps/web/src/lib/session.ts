"use client";

import { range } from "./range";
import { signIn } from "./wallet";

export type Session = { token: string; account: string };

/** One sign-in serves the Range and the shop: both run on the same server. */
const KEY = "range-session";

export function loadSession(): Session | null {
  try {
    const s = sessionStorage.getItem(KEY);
    return s ? (JSON.parse(s) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {}
}

/** Signs the server's NEP-413 message with a testnet wallet and opens a session. */
export async function startSession(): Promise<Session> {
  const n = await range.nonce();
  const signed = await signIn(n);
  const s = await range.session({ ...signed, nonce: n.nonce });
  saveSession(s);
  return s;
}
