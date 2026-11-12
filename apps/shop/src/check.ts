/**
 * Facts about an address someone is about to pay, and a verdict decided from them by fixed
 * rules. The model only explains the verdict; it never decides it.
 */

export type Chain = "near" | "base-sepolia" | "base";

export interface ScamEntry {
  address: string;
  evidence: string;
  /** The paid bounty that added it, so every entry traces to an on-chain payout. */
  bounty: number;
}

export interface Facts {
  target: string;
  chain: Chain;
  /** Where it was looked up, such as "NEAR mainnet" or "Base Sepolia". */
  network: string;
  exists: boolean;
  isContract: boolean;
  txCount: number;
  /** Set when only sent transactions could be counted. */
  sentOnly?: boolean;
  /** Unix ms of the oldest transaction seen; `null` when there's none or it's unknown. */
  firstSeen: number | null;
  /** NEAR only: full-access keys. A contract with none can't have its code swapped. */
  fullAccessKeys: number | null;
  /** The name it imitates, if it's one or two characters away from a known one. */
  lookalikeOf: string | null;
  scam: ScamEntry | null;
  /** The explorer's own scam flag, where it has one. */
  flaggedByExplorer: boolean;
}

export type Level = "looks fine" | "be careful" | "do not pay";

export interface Verdict {
  level: Level;
  reasons: string[];
}

const DAY_MS = 86_400_000;

export function chainOf(target: string): Chain | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(target)) return "base-sepolia";
  if (
    /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(target) &&
    target.length >= 2 &&
    target.length <= 64
  )
    return "near";
  return null;
}

/** Characters people swap in to fake a name. */
const CONFUSABLE: [RegExp, string][] = [
  [/rn/g, "m"],
  [/vv/g, "w"],
  [/0/g, "o"],
  [/1/g, "l"],
  [/i/g, "l"],
  [/3/g, "e"],
  [/5/g, "s"],
  [/\$/g, "s"],
];

const skeleton = (s: string) =>
  CONFUSABLE.reduce((acc, [re, to]) => acc.replace(re, to), s.toLowerCase());

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j] as number;
      row[j] = Math.min(
        cur + 1,
        (row[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = cur;
    }
  }
  return row[b.length] as number;
}

/** The known name `target` imitates, or `null` if it is one, or isn't close to any. */
export function lookalike(target: string, known: readonly string[]): string | null {
  const t = target.toLowerCase();
  if (known.some((k) => k.toLowerCase() === t)) return null;
  for (const k of known) {
    const kl = k.toLowerCase();
    if (skeleton(t) === skeleton(kl)) return k;
    if (
      !t.startsWith("0x") &&
      Math.abs(t.length - kl.length) <= 2 &&
      distance(t, kl) <= (kl.length > 8 ? 2 : 1)
    )
      return k;
    // Address poisoning copies the first and last characters of a real address.
    if (
      t.startsWith("0x") &&
      kl.startsWith("0x") &&
      t.slice(0, 6) === kl.slice(0, 6) &&
      t.slice(-4) === kl.slice(-4)
    )
      return k;
  }
  return null;
}

export function verdict(f: Facts, now: number): Verdict {
  const stop: string[] = [];
  const care: string[] = [];
  if (f.scam)
    stop.push(`It's on the community scam list (bounty ${f.scam.bounty}): ${f.scam.evidence}`);
  if (f.flaggedByExplorer) stop.push("The block explorer flags it as a scam.");
  if (f.lookalikeOf) stop.push(`It looks like ${f.lookalikeOf} but isn't it.`);
  if (!f.exists) care.push(`It has never been used on ${f.network}.`);
  else {
    if (f.sentOnly && f.isContract)
      care.push(`It's a contract, and we can't see its history on ${f.network}.`);
    else if (f.txCount < 3)
      care.push(
        `It has ${f.sentOnly ? "sent " : ""}only ${f.txCount} transaction${f.txCount === 1 ? "" : "s"}.`,
      );
    if (f.firstSeen !== null && now - f.firstSeen < 7 * DAY_MS)
      care.push("It first appeared less than a week ago.");
  }
  if (f.isContract && f.fullAccessKeys !== null && f.fullAccessKeys > 0)
    care.push("It's a contract whose owner can still replace its code.");
  if (stop.length) return { level: "do not pay", reasons: [...stop, ...care] };
  if (care.length) return { level: "be careful", reasons: care };
  return {
    level: "looks fine",
    reasons: ["It's established, active and not on any list we check."],
  };
}

export interface Network {
  /** NEAR RPC, such as https://test.rpc.fastnear.com */
  nearRpc: string;
  /** FastNEAR transactions API, such as https://tx.test.fastnear.com */
  nearTx: string;
  /** Blockscout API for the EVM chain, such as https://base-sepolia.blockscout.com */
  blockscout: string;
  /**
   * EVM JSON-RPC, used instead of Blockscout where its API refuses servers (Base mainnet's sits
   * behind a bot challenge). It sees only sent transactions and has no scam flag.
   */
  evmRpc?: string;
  /** How a report names it: `near` like "NEAR testnet", `evm` like "Base Sepolia". */
  names?: { near: string; evm: string };
}

export interface Sources extends Network {
  /**
   * People check the accounts they really pay, which live on mainnet. With this set, anything
   * but a `.testnet` name is looked up here first, and on the testnet sources only if it has
   * never been used here.
   */
  mainnet?: Network;
  known: readonly string[];
  scamList: () => Promise<ScamEntry[]>;
  fetch?: typeof fetch;
}

async function json<T>(f: typeof fetch, url: string, body?: unknown): Promise<T | undefined> {
  const res = await f(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) return undefined;
  return (await res.json()) as T;
}

async function nearQuery<T>(f: typeof fetch, rpc: string, params: Record<string, unknown>) {
  const out = await json<{ result?: T & { error?: string } }>(f, rpc, {
    jsonrpc: "2.0",
    id: 0,
    method: "query",
    params: { finality: "final", ...params },
  });
  return out?.result && !out.result.error ? out.result : undefined;
}

const NO_CODE = "11111111111111111111111111111111";

const NEAR_TX =
  /(?:^|\s)https:\/\/(?:testnet\.)?(?:nearblocks\.io|explorer\.(?:testnet\.)?near\.org)\/(?:txns|transactions)\/([1-9A-HJ-NP-Za-km-z]{43,44})\b/;
const EVM_TX =
  /(?:^|\s)https:\/\/(?:sepolia\.)?(?:basescan\.org|etherscan\.io|[a-z0-9-]+\.blockscout\.com)\/tx\/(0x[0-9a-fA-F]{64})\b/;

type NearTx = { transaction?: { signer_id?: string; receiver_id?: string } };

/**
 * Whether `evidence` links a transaction that `address` signed or received: NEAR transactions
 * are looked up by hash in the transactions API, or else by RPC with the address or the
 * reporter as the sender; EVM ones in Blockscout, by `from` and `to`. The parties must match
 * exactly. This shows the address was used, not that it scammed anyone: anyone can send it a
 * transaction, so trust tiers, council approval and retraction are what limit a bad report.
 */
export async function linkedTxInvolves(
  evidence: string,
  address: string,
  reporter: string,
  s: Omit<Sources, "scamList">,
): Promise<boolean> {
  const f = s.fetch ?? fetch;
  const a = address.toLowerCase();
  const party = (tx: NearTx | undefined) =>
    [tx?.transaction?.signer_id, tx?.transaction?.receiver_id].some((p) => p?.toLowerCase() === a);
  const near = NEAR_TX.exec(evidence)?.[1];
  if (near && chainOf(address) === "near") {
    const indexed = await json<{ transactions?: NearTx[] }>(f, `${s.nearTx}/v0/transactions`, {
      tx_hashes: [near],
    }).catch(() => undefined);
    if (indexed?.transactions?.length) return indexed.transactions.some(party);
    for (const sender of [address, reporter]) {
      const out = await json<{ result?: NearTx }>(f, s.nearRpc, {
        jsonrpc: "2.0",
        id: 0,
        method: "tx",
        params: { tx_hash: near, sender_account_id: sender },
      }).catch(() => undefined);
      if (out?.result) return party(out.result);
    }
    return false;
  }
  const evm = EVM_TX.exec(evidence)?.[1];
  if (evm && chainOf(address) !== "near" && chainOf(address) !== null) {
    const tx = await json<{ from?: { hash?: string }; to?: { hash?: string } }>(
      f,
      `${s.blockscout}/api/v2/transactions/${evm}`,
    ).catch(() => undefined);
    return [tx?.from?.hash, tx?.to?.hash].some((p) => p?.toLowerCase() === a);
  }
  return false;
}

const TESTNET_NAMES = { near: "NEAR testnet", evm: "Base Sepolia" };

export async function gather(target: string, s: Sources): Promise<Facts> {
  if (!chainOf(target)) throw new Error("not a NEAR account or 0x address");
  const scams = await s.scamList();
  const scam = scams.find((e) => e.address.toLowerCase() === target.toLowerCase()) ?? null;
  const lookalikeOf = lookalike(target, s.known);
  const f = s.fetch ?? fetch;
  const main =
    s.mainnet && !target.toLowerCase().endsWith(".testnet")
      ? await lookUp(target, s.mainnet, f, true).catch(() => null)
      : null;
  if (main?.exists) return { ...main, lookalikeOf, scam };
  const test = await lookUp(target, s, f, false);
  if (main && !test.exists)
    return { ...main, network: `${main.network} or ${test.network}`, lookalikeOf, scam };
  return { ...test, lookalikeOf, scam };
}

async function lookUp(
  target: string,
  n: Network,
  f: typeof fetch,
  mainnet: boolean,
): Promise<Omit<Facts, "lookalikeOf" | "scam">> {
  const names = n.names ?? (mainnet ? { near: "NEAR mainnet", evm: "Base" } : TESTNET_NAMES);
  if (chainOf(target) === "near") {
    const chain = "near" as const;
    const account = await nearQuery<{ code_hash: string }>(f, n.nearRpc, {
      request_type: "view_account",
      account_id: target,
    });
    const keys = await nearQuery<{ keys: { access_key: { permission: unknown } }[] }>(
      f,
      n.nearRpc,
      {
        request_type: "view_access_key_list",
        account_id: target,
      },
    );
    const txs = await json<{ txs_count: number; account_txs: { tx_block_timestamp: string }[] }>(
      f,
      `${n.nearTx}/v0/account`,
      { account_id: target, max_block_height: null },
    );
    // Newest first, one page: its last entry is the account's first only if the page holds all.
    const oldest =
      txs && txs.account_txs.length >= txs.txs_count
        ? txs.account_txs.at(-1)?.tx_block_timestamp
        : undefined;
    return {
      target,
      chain,
      network: names.near,
      exists: account !== undefined,
      isContract: account !== undefined && account.code_hash !== NO_CODE,
      txCount: txs?.txs_count ?? 0,
      firstSeen: oldest ? Number(BigInt(oldest) / 1_000_000n) : null,
      fullAccessKeys: keys
        ? keys.keys.filter((k) => k.access_key.permission === "FullAccess").length
        : null,
      flaggedByExplorer: false,
    };
  }
  if (n.evmRpc) {
    const call = async (method: string) =>
      (
        await json<{ result?: string }>(f, n.evmRpc as string, {
          jsonrpc: "2.0",
          id: 1,
          method,
          params: [target, "latest"],
        })
      )?.result;
    const [nonce, code, balance] = await Promise.all(
      ["eth_getTransactionCount", "eth_getCode", "eth_getBalance"].map(call),
    );
    if (nonce === undefined) throw new Error("EVM RPC unavailable");
    const sent = Number(BigInt(nonce));
    const isContract = code !== undefined && code !== "0x";
    return {
      target,
      chain: mainnet ? "base" : "base-sepolia",
      network: names.evm,
      exists: sent > 0 || isContract || BigInt(balance ?? "0x0") > 0n,
      isContract,
      txCount: sent,
      sentOnly: true,
      firstSeen: null,
      fullAccessKeys: null,
      flaggedByExplorer: false,
    };
  }
  const addr = await json<{ is_contract: boolean; is_scam?: boolean; coin_balance: string | null }>(
    f,
    `${n.blockscout}/api/v2/addresses/${target}`,
  );
  const counters = await json<{ transactions_count: string }>(
    f,
    `${n.blockscout}/api/v2/addresses/${target}/counters`,
  );
  const txCount = Number(counters?.transactions_count ?? 0);
  return {
    target,
    chain: mainnet ? "base" : "base-sepolia",
    network: names.evm,
    exists: addr !== undefined && (txCount > 0 || addr.coin_balance !== null),
    isContract: addr?.is_contract ?? false,
    txCount,
    firstSeen: null,
    fullAccessKeys: null,
    flaggedByExplorer: addr?.is_scam ?? false,
  };
}
