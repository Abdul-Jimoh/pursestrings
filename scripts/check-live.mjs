// Checks the docs' links against public data: every NEAR testnet or Base Sepolia transaction and
// account that README.md, THREAT_MODEL.md and AGENTS.md link exists, and the live accounts have no
// full-access key and run the code the README names. It doesn't check what each transaction shows. No keys, no build: Node 22 or newer.
// A transaction that failed is reported, not counted wrong: some links show a refused attack.
import { readFileSync } from "node:fs";

const NEAR_RPC = "https://test.rpc.fastnear.com";
const NEAR_TX = "https://tx.test.fastnear.com/v0/transactions";
const BASE_RPC = "https://sepolia.base.org";
const DOCS = ["README.md", "THREAT_MODEL.md", "AGENTS.md"];
// The README's "What's live" table: accounts that only agent keys (or none) may act for.
const KEYLESS = [
  "factory.ps-spike-1028.testnet",
  "shop.factory.ps-spike-1028.testnet",
  "board.factory.ps-spike-1028.testnet",
  "range.factory.ps-spike-1028.testnet",
];
const CODE = {
  "shop.factory.ps-spike-1028.testnet": "FVksmpMe",
  "board.factory.ps-spike-1028.testnet": "FVksmpMe",
};

const post = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "pursestrings-check-live" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
};
const nearQuery = (params) =>
  post(NEAR_RPC, {
    jsonrpc: "2.0",
    id: 0,
    method: "query",
    params: { finality: "final", ...params },
  });

const text = DOCS.map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
const unique = (re) => [...new Set([...text.matchAll(re)].map((m) => m[1]))];
const nearTxs = unique(/testnet\.nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})/g);
const nearAccounts = unique(/testnet\.nearblocks\.io\/address\/([a-z0-9._-]+)/g);
const baseTxs = unique(/sepolia\.basescan\.org\/tx\/(0x[0-9a-fA-F]{64})/g);
const baseAccounts = unique(/sepolia\.basescan\.org\/address\/(0x[0-9a-fA-F]{40})/g);

let missing = 0;
const line = (ok, what, detail) => {
  if (!ok) missing++;
  console.log(`${ok ? "ok     " : "MISSING"} ${what}${detail ? `: ${detail}` : ""}`);
};

console.log(
  `${nearTxs.length} NEAR transactions, ${baseTxs.length} Base transactions, ${nearAccounts.length + baseAccounts.length} accounts linked\n`,
);

try {
  for (let i = 0; i < nearTxs.length; i += 20) {
    const batch = nearTxs.slice(i, i + 20);
    const found = new Map(
      ((await post(NEAR_TX, { tx_hashes: batch })).transactions ?? []).map((t) => [
        t.execution_outcome?.id ?? t.transaction?.hash,
        t,
      ]),
    );
    for (const hash of batch) {
      const t = found.get(hash);
      const failed = t?.receipts?.some(
        (r) => "Failure" in (r.execution_outcome?.outcome?.status ?? {}),
      );
      line(
        Boolean(t),
        `NEAR tx ${hash.slice(0, 8)}…`,
        t &&
          `${t.transaction.signer_id} → ${t.transaction.receiver_id}${failed ? ", a receipt failed (expected where the link shows a refusal)" : ""}`,
      );
    }
  }

  for (const hash of baseTxs) {
    const r = (
      await post(BASE_RPC, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [hash],
      })
    ).result;
    line(
      Boolean(r),
      `Base tx ${hash.slice(0, 10)}…`,
      r && (r.status === "0x1" ? "succeeded" : "reverted"),
    );
  }

  for (const account of nearAccounts) {
    const r = await nearQuery({ request_type: "view_account", account_id: account });
    line(Boolean(r.result?.code_hash), `NEAR account ${account}`);
  }

  for (const address of baseAccounts) {
    const nonce = (
      await post(BASE_RPC, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionCount",
        params: [address, "latest"],
      })
    ).result;
    line(
      nonce !== undefined,
      `Base address ${address.slice(0, 10)}…`,
      nonce && `${Number.parseInt(nonce, 16)} transactions sent`,
    );
  }

  console.log("");
  for (const account of KEYLESS) {
    const keys =
      (await nearQuery({ request_type: "view_access_key_list", account_id: account })).result
        ?.keys ?? [];
    const full = keys.filter((k) => k.access_key.permission === "FullAccess").length;
    line(
      full === 0,
      `${account} has no full-access key`,
      `${keys.length - full} function-call key${keys.length - full === 1 ? "" : "s"}, ${full} full-access`,
    );
  }
  for (const [account, prefix] of Object.entries(CODE)) {
    const hash =
      (await nearQuery({ request_type: "view_account", account_id: account })).result?.code_hash ??
      "";
    line(hash.startsWith(prefix), `${account} runs code ${prefix}…`, hash);
  }
} catch (e) {
  // A sandbox without network shouldn't read as a broken claim.
  console.error(
    `\ncan't reach NEAR testnet or Base Sepolia (${e.cause?.code ?? e.message}): this check needs the internet`,
  );
  process.exit(2);
}

console.log(
  `\n${missing === 0 ? "every linked transaction and account exists, and the live accounts match the README" : `${missing} not found`}`,
);
process.exit(missing === 0 ? 0 : 1);
