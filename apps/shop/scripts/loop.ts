// One full loop on testnet, from sale to payout: the agent is talked under the floor and the
// contract refuses, quotes a fair price, a buyer pays, the check runs, the agent delivers and
// the split pays out. Without SHOP_MODEL_KEY the report is the verdict's reasons, unpolished.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeQuote, Pursestrings } from "@pursestrings/sdk";
import { deliverPaid, Reports } from "../src/deliver.ts";
import { type Chat, fromYocto, toYocto } from "../src/seller.ts";

const RPC = process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const SHOP = process.env.SHOP_ACCOUNT ?? "shop.factory.ps-spike-1028.testnet";
const BUYER = process.env.BUYER ?? "ps-fund-1107a.testnet";
const OWNER = "ps-spike-1028.testnet";
const DAO = "ps-community-1107.testnet";
const TARGET = process.argv[2] ?? "ps-cornmunity-1107.testnet";
const key = (id: string) =>
  JSON.parse(readFileSync(join(homedir(), ".near-credentials/testnet", `${id}.json`), "utf8"))
    .private_key as string;

const started = Date.now();
const step = (s: string) =>
  console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s  ${s}`);
const near = (y: string | bigint) => `${fromYocto(y)} NEAR`;

const shop = new Pursestrings(RPC, SHOP);
const agent = shop.agent(key(SHOP));
const buyer = shop.caller(BUYER, key(BUYER));
const balance = async (id: string) =>
  BigInt(
    ((await shop.provider.viewAccount({ accountId: id })) as unknown as { amount: string }).amount,
  );

const item = `check:${TARGET}`;
const low = await agent.quote(BUYER, "Near", toYocto("0.01") as bigint, item);
step(
  `buyer haggles to 0.01 NEAR → contract: ${low.value ? describeQuote(low.value, near) : low.error} (${low.txHash})`,
);

const fair = await agent.quote(BUYER, "Near", toYocto("0.08") as bigint, item);
if (!fair.value || !("Quoted" in fair.value))
  throw new Error(`quote failed: ${JSON.stringify(fair)}`);
const orderId = fair.value.Quoted.order_id;
step(`agent quotes 0.08 NEAR → order ${orderId} (${fair.txHash})`);

const [owner0, dao0] = await Promise.all([balance(OWNER), balance(DAO)]);
const paid = await buyer.payNear(orderId, toYocto("0.08") as bigint);
if (!paid.ok) throw new Error(`payment failed: ${paid.error}`);
const held = await shop.order(orderId);
step(
  `${BUYER} pays → order ${held?.status}, ${near(held?.held ?? "0")} held until delivery (${paid.txHash})`,
);

const model: Chat = process.env.SHOP_MODEL_KEY
  ? (await import("../../range/src/model.ts")).openAiCompatible({
      baseUrl: process.env.SHOP_MODEL_URL ?? "https://cloud-api.near.ai/v1",
      apiKey: process.env.SHOP_MODEL_KEY,
      model: process.env.SHOP_MODEL ?? "anthropic/claude-haiku-5-5",
      maxTokens: 400,
    })
  : {
      chat: async () => {
        throw new Error("no model");
      },
    };
const reports = new Reports(join(import.meta.dirname, "../data/loop-reports.jsonl"));
await deliverPaid({
  shop,
  agent,
  model,
  reports,
  sources: {
    nearRpc: RPC,
    nearTx: "https://tx.test.fastnear.com",
    blockscout: "https://base-sepolia.blockscout.com",
    known: [OWNER, DAO, SHOP, "wrap.testnet", "usdc.fakes.testnet"],
  },
  log: () => {},
});
const report = reports.get(orderId);
step(
  `check runs → "${report?.verdict.level}", delivered with ${report?.receipt?.slice(0, 22)}… (${report?.deliverTx})`,
);
console.log(`\n${report?.text}\n`);

await new Promise((r) => setTimeout(r, 3_000));
const done = await shop.order(orderId);
const [owner1, dao1] = await Promise.all([balance(OWNER), balance(DAO)]);
step(
  `split paid: owner +${near(owner1 - owner0)}, community DAO +${near(dao1 - dao0)}, shop keeps ${near(done?.held ?? "0")}`,
);
