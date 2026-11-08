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

/** The connected account, if a wallet is already connected on this browser. */
export async function connectedAccount(): Promise<string | null> {
  try {
    const { accounts } = await (await wallet()).getConnectedWallet();
    return accounts[0]?.accountId ?? null;
  } catch {
    return null;
  }
}

export async function connectAccount(): Promise<string> {
  const w = await (await wallet()).connect();
  const [account] = await w.getAccounts();
  if (!account) throw new Error("the wallet didn't return an account");
  return account.accountId;
}

export async function disconnect() {
  await (await wallet()).disconnect();
}

const TGAS = 10n ** 12n;

/** Owner methods take exactly 1 yoctoNEAR, so only a full-access key (a wallet prompt) can call them. */
export function ownerCall(
  contract: string,
  method: string,
  args: object,
  { tgas = 100n, deposit = "1" } = {},
) {
  return walletCall(contract, method, args, { tgas, deposit });
}

/** Signs one function call with the connected wallet; returns the transaction hash. */
export async function walletCall(
  contract: string,
  method: string,
  args: object,
  { tgas, deposit }: { tgas: bigint; deposit: string },
): Promise<string | undefined> {
  const { wallet: w } = await (await wallet()).getConnectedWallet();
  const out = await w.signAndSendTransaction({
    receiverId: contract,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName: method, args, gas: (tgas * TGAS).toString(), deposit },
      },
    ],
  });
  return (out as { transaction?: { hash?: string } } | undefined)?.transaction?.hash;
}
