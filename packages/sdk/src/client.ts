import {
  Account,
  actions,
  getTransactionLastResult,
  JsonRpcProvider,
  type KeyPairString,
} from "near-api-js";
import type {
  Asset,
  Bounty,
  BudgetStatus,
  Decision,
  Order,
  PolicyOp,
  QuoteDecision,
  RefundDecision,
  Request,
  SpendRequest,
  TrustRecord,
  WindowStatus,
} from "./types.ts";

const TGAS = 10n ** 12n;
const ONE_YOCTO = 1n;

export interface Outcome<T> {
  ok: boolean;
  value: T | undefined;
  logs: string[];
  txHash: string;
  /** Why the transaction or one of its receipts failed. */
  error?: string;
}

interface ReceiptOutcome {
  outcome: { logs: string[]; status: unknown };
}

interface TxResponse {
  transaction: { hash: string };
  transaction_outcome: ReceiptOutcome;
  receipts_outcome: ReceiptOutcome[];
  status: unknown;
}

function failure(status: unknown): string | undefined {
  if (status && typeof status === "object" && "Failure" in status) {
    return JSON.stringify((status as { Failure: unknown }).Failure);
  }
  return undefined;
}

/** NEP-297 events in the logs, parsed. */
export function events(logs: string[]): { event: string; data: Record<string, unknown> }[] {
  return logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)));
}

/** Reads a Pursestrings account. Signing clients come from `agent`, `owner` and `caller`. */
export class Pursestrings {
  readonly provider: JsonRpcProvider;
  readonly rpc: string;
  readonly accountId: string;

  constructor(rpc: string, accountId: string) {
    this.rpc = rpc;
    this.accountId = accountId;
    this.provider = new JsonRpcProvider({ url: rpc });
  }

  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await this.provider.callFunction({
      contractId: this.accountId,
      method,
      args,
      blockQuery: { finality: "optimistic" },
    })) as T;
  }

  policy() {
    return this.view<Record<string, unknown>>("policy");
  }
  request(reqId: number) {
    return this.view<Request | null>("request", { req_id: reqId });
  }
  nextReqId() {
    return this.view<number>("next_req_id");
  }
  /** Newest first, ids `[before - limit, before)`; pruned ids are skipped. */
  recentRequests(limit = 20, before?: number) {
    return this.view<[number, Request][]>("recent_requests", {
      limit,
      ...(before === undefined ? {} : { before }),
    });
  }
  budgetStatus(asset: Asset) {
    return this.view<BudgetStatus | null>("budget_status", { asset });
  }
  groupStatus(name: string) {
    return this.view<WindowStatus[] | null>("group_status", { name });
  }
  feeStatus() {
    return this.view<WindowStatus>("fee_status");
  }
  evmOpen() {
    return this.view<[number, Request][]>("evm_open");
  }
  intentsOpen() {
    return this.view<[number, Request][]>("intents_open");
  }
  intentsKey() {
    return this.view<string | null>("intents_key");
  }
  owner() {
    return this.view<string>("owner");
  }
  order(orderId: number) {
    return this.view<Order | null>("order", { order_id: orderId });
  }
  recentOrders(limit = 20, before?: number) {
    return this.view<[number, Order][]>("recent_orders", {
      limit,
      ...(before === undefined ? {} : { before }),
    });
  }
  bounty(id: number) {
    return this.view<Bounty | null>("bounty", { id });
  }
  recentBounties(limit = 20, before?: number) {
    return this.view<[number, Bounty][]>("recent_bounties", {
      limit,
      ...(before === undefined ? {} : { before }),
    });
  }
  record(account: string) {
    return this.view<TrustRecord>("record", { account });
  }

  /** The agent signs with its function-call key on the account itself. */
  agent(secretKey: string): Agent {
    return new Agent(this, new Account(this.accountId, this.provider, secretKey as KeyPairString));
  }

  owned(ownerId: string, secretKey: string): Owner {
    return new Owner(this, new Account(ownerId, this.provider, secretKey as KeyPairString));
  }

  /** Any NEAR account: the calls anyone may make. */
  caller(accountId: string, secretKey: string): Caller {
    return new Caller(this, new Account(accountId, this.provider, secretKey as KeyPairString));
  }
}

export class Caller {
  readonly purse: Pursestrings;
  readonly signer: Account;

  constructor(purse: Pursestrings, signer: Account) {
    this.purse = purse;
    this.signer = signer;
  }

  async call<T>(
    method: string,
    args: Record<string, unknown> = {},
    opts: { deposit?: bigint; tgas?: bigint; contractId?: string } = {},
  ): Promise<Outcome<T>> {
    const res = (await this.signer.signAndSendTransaction({
      receiverId: opts.contractId ?? this.purse.accountId,
      actions: [actions.functionCall(method, args, (opts.tgas ?? 300n) * TGAS, opts.deposit ?? 0n)],
      throwOnFailure: false,
    })) as unknown as TxResponse;
    const outcomes = [res.transaction_outcome, ...res.receipts_outcome];
    const error =
      failure(res.status) ?? outcomes.map((o) => failure(o.outcome.status)).find(Boolean);
    let value: T | undefined;
    if (!failure(res.status)) {
      value = getTransactionLastResult(res as never) as T;
    }
    return {
      ok: error === undefined,
      value,
      logs: outcomes.flatMap((o) => o.outcome.logs),
      txHash: res.transaction.hash,
      ...(error ? { error } : {}),
    };
  }

  settleIntent(reqId: number) {
    return this.call<string | null>("settle_intent", { req_id: reqId });
  }
  /** Asks the MPC network to confirm a signed EVM transaction is finalized and succeeded. */
  confirmEvm(reqId: number) {
    return this.call<boolean>("confirm_evm", { req_id: reqId }, { deposit: ONE_YOCTO });
  }
  releaseEvm(reqId: number) {
    return this.call<boolean>("release_evm", { req_id: reqId }, { deposit: ONE_YOCTO });
  }
  expireRequest(reqId: number) {
    return this.call<void>("expire_request", { req_id: reqId });
  }
  /** Pays a NEAR quote; any extra comes back. */
  payNear(orderId: number, yocto: bigint) {
    return this.call<void>("pay", { order_id: orderId }, { deposit: yocto, tgas: 100n });
  }
  /** Pays a NEP-141 quote through the token; a payment that doesn't match comes back in full. */
  payToken(token: string, orderId: number, amount: bigint) {
    return this.call<string>(
      "ft_transfer_call",
      { receiver_id: this.purse.accountId, amount: amount.toString(), msg: String(orderId) },
      { contractId: token, deposit: ONE_YOCTO, tgas: 200n },
    );
  }
  claimBounty(id: number) {
    return this.call<void>("claim_bounty", { id }, { deposit: ONE_YOCTO, tgas: 30n });
  }
  submitBounty(id: number, work: string) {
    return this.call<void>("submit_bounty", { id, work }, { deposit: ONE_YOCTO, tgas: 30n });
  }
  /** Council members: approve a payout within their tier, post bounties, or freeze. */
  councilApprove(reqId: number) {
    return this.call<void>("council_approve", { req_id: reqId }, { deposit: ONE_YOCTO });
  }
  postBounty(title: string, asset: Asset, reward: bigint) {
    return this.call<number>(
      "post_bounty",
      { title, asset, reward: reward.toString() },
      { deposit: ONE_YOCTO, tgas: 30n },
    );
  }
  freeze() {
    return this.call<void>("freeze", {}, { deposit: ONE_YOCTO, tgas: 30n });
  }
}

export class Agent extends Caller {
  /** The agent key's gas allowance pays for these, so it gets only what it needs. */
  async requestSpend(request: SpendRequest): Promise<Outcome<Decision>> {
    return this.call<Decision>("request_spend", { request }, { tgas: 250n });
  }
  cancelRequest(reqId: number) {
    return this.call<void>("cancel_request", { req_id: reqId }, { tgas: 30n });
  }
  /** Offers `item` at `price`; the contract refuses anything under the owner's floor. */
  quote(buyer: string | null, asset: Asset, price: bigint, item: string) {
    return this.call<QuoteDecision>(
      "quote",
      { buyer, asset, price: price.toString(), item },
      { tgas: 30n },
    );
  }
  deliver(orderId: number, receipt: string) {
    return this.call<void>("deliver", { order_id: orderId, receipt }, { tgas: 30n });
  }
  refund(orderId: number, amount: bigint, reason: string) {
    return this.call<RefundDecision>(
      "refund",
      { order_id: orderId, amount: amount.toString(), reason },
      { tgas: 60n },
    );
  }
}

export class Owner extends Caller {
  private owner<T>(method: string, args: Record<string, unknown> = {}) {
    return this.call<T>(method, args, { deposit: ONE_YOCTO });
  }
  approve(reqId: number) {
    return this.owner<void>("approve_request", { req_id: reqId });
  }
  reject(reqId: number) {
    return this.owner<void>("reject_request", { req_id: reqId });
  }
  /** Tightening ops apply now; anything looser is queued and returns its proposal id. */
  propose(ops: PolicyOp[]) {
    return this.owner<number | null>("propose", { ops });
  }
  cancelProposal(id: number) {
    return this.owner<void>("cancel_proposal", { id });
  }
  applyProposal(id: number) {
    return this.owner<void>("apply_proposal", { id });
  }
  freeze() {
    return this.owner<void>("freeze");
  }
  addAgent(publicKey: string, allowanceYocto: bigint) {
    return this.owner<void>("add_agent", {
      public_key: publicKey,
      allowance: allowanceYocto.toString(),
    });
  }
  revokeAgent(publicKey: string) {
    return this.owner<void>("revoke_agent", { public_key: publicKey });
  }
  withdraw(asset: Asset, amount: bigint) {
    return this.owner<void>("withdraw", { asset, amount: amount.toString() });
  }
  registerIntentsKey() {
    return this.owner<void>("register_intents_key");
  }
}
