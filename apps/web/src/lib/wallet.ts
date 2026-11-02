"use client";

import type { NearConnector } from "@hot-labs/near-connect";

let connector: Promise<NearConnector> | undefined;

/** Loaded on demand: the wallet connector only runs in the browser. */
export function wallet(): Promise<NearConnector> {
  connector ??= import("@hot-labs/near-connect").then(
    ({ NearConnector }) => new NearConnector({ network: "testnet" }),
  );
  return connector;
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Connects a testnet wallet and signs the Range's sign-in message (NEP-413) in one step. */
export async function signIn(nonce: { nonce: string; message: string; recipient: string }) {
  const c = await wallet();
  const signed = new Promise<{ accountId: string; publicKey: string; signature: string }>(
    (resolve, reject) => {
      c.on("wallet:signInAndSignMessage", (t) => {
        const acc = t.accounts[0];
        if (acc?.signedMessage) resolve(acc.signedMessage);
        else reject(new Error("the wallet didn't return a signed message"));
      });
    },
  );
  await c.connect({
    signMessageParams: {
      message: nonce.message,
      recipient: nonce.recipient,
      nonce: fromBase64(nonce.nonce),
    },
  });
  return signed;
}
