// Testnet helpers shared by the setup and upgrade scripts. Keys come from ~/.near-credentials.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Account,
  actions,
  getTransactionLastResult,
  JsonRpcProvider,
  type KeyPairString,
} from "near-api-js";

export const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
export const ROOT = join(import.meta.dirname, "../../..");
export const CREDS = join(homedir(), ".near-credentials/testnet");

export const FACTORY = "factory.ps-spike-1028.testnet";
export const ADMIN = "ps-spike-1028.testnet";
export const COUNCIL = [ADMIN, "ps-funder-1101.testnet"];
export const DAO = "ps-community-1107.testnet";
export const SHOP = `shop.${FACTORY}`;
/** `BOARD_NAME` picks the bounty board; the first one, on older code, is `bounties`. */
export const BOUNTIES = `${process.env.BOARD_NAME ?? "board"}.${FACTORY}`;

export const TGAS = 10n ** 12n;
export const N = (near: number) => (BigInt(Math.round(near * 1_000)) * 10n ** 21n).toString();
export const provider = new JsonRpcProvider({ url: RPC });

export function signer(accountId: string): Account {
  const file = join(CREDS, `${accountId}.json`);
  if (!existsSync(file)) throw new Error(`no key for ${accountId} in ${CREDS}`);
  const key = JSON.parse(readFileSync(file, "utf8")).private_key as KeyPairString;
  return new Account(accountId, provider, key);
}

export async function rpc<T>(params: Record<string, unknown>): Promise<T | undefined> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "query",
      params: { finality: "final", ...params },
    }),
  });
  const body = (await res.json()) as { result?: T & { error?: string } };
  return body.result && !body.result.error ? body.result : undefined;
}

export const codeHashOf = async (id: string) =>
  (await rpc<{ code_hash: string }>({ request_type: "view_account", account_id: id }))?.code_hash;

export async function view<T>(
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

export async function call(
  from: Account,
  receiverId: string,
  method: string,
  args: object | Uint8Array,
  deposit = 0n,
  tgas = 100n,
) {
  const res = await from.signAndSendTransaction({
    receiverId,
    actions: [actions.functionCall(method, args, tgas * TGAS, deposit)],
  });
  const hash = (res as unknown as { transaction: { hash: string } }).transaction.hash;
  console.log(`  ${from.accountId} → ${receiverId}.${method}: ${hash}`);
  return getTransactionLastResult(res as never);
}

export const base58 = (bytes: Uint8Array) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = A[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
};

export const borshBytes = (b: Uint8Array) => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};

/** Votes a DAO proposal through with every council member until it's no longer in progress. */
export async function daoDo(description: string, kind: Record<string, unknown>) {
  const proposer = signer(COUNCIL[1] as string);
  const id = (await call(
    proposer,
    DAO,
    "add_proposal",
    { proposal: { description, kind } },
    10n ** 24n,
    300n,
  )) as number;
  for (const member of COUNCIL) {
    const p = await view<{ status: string }>(DAO, "get_proposal", { id });
    if (p.status !== "InProgress") break;
    await call(
      signer(member),
      DAO,
      "act_proposal",
      { id, action: "VoteApprove", proposal: kind },
      0n,
      300n,
    );
  }
  const p = await view<{ status: string }>(DAO, "get_proposal", { id });
  console.log(`  proposal ${id} "${description}": ${p.status}`);
  if (p.status !== "Approved") throw new Error(`proposal ${id} ended ${p.status}`);
}
