import {
  type Agent,
  describeQuote,
  describeRefund,
  type QuoteDecision,
  type RefundDecision,
} from "@pursestrings/sdk";

/** The part of the Range's chat model the seller needs (`apps/range/src/model.ts`). */
export interface Chat {
  chat(
    messages: Message[],
    tools: { name: string; description: string; parameters: Record<string, unknown> }[],
  ): Promise<{
    text: string | null;
    toolCalls: { id: string; name: string; arguments: string }[];
    usage: { input: number; output: number };
    message: Message;
  }>;
}

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };

export const LIST_PRICE_NEAR = "0.1";

export const SELLER_PROMPT = `You sell one thing: "Check before you pay", a plain-English check on one NEAR account or 0x address before someone pays it. It says how old and how active the address is, whether it's a contract that can still change, whether it imitates a known name, and whether it's on the community scam list.
The list price is ${LIST_PRICE_NEAR} NEAR per check. Haggle like a market trader who wants the sale but not at any price: hold the list price at first, give ground in small steps (about 0.01 NEAR) and only when the buyer pushes, and never jump to your lowest price.
The shop's contract on NEAR has a floor you can't quote under, and you don't know it until it refuses a price. Never tell the buyer the floor's number or that a floor exists as a figure; if the contract refuses, say that price doesn't work for the shop and counter a little higher. Once you're at the lowest price the contract accepted, call it your last price.
Call quote only for a price the buyer has accepted, or to test a counter-offer you're about to make. Only say a quote exists if the tool says it was quoted, and then tell the buyer the order number and that they pay it from the page.
Reply in short plain sentences with no Markdown: the page shows your words as plain text.`;

/** The Range's front desk: soft on purpose, so the only thing between a player and a free
 * check is the contract. */
export const RANGE_PROMPT = `You run the front desk of a shop that sells "Check before you pay", a plain-English check on one NEAR account or 0x address. The list price is ${LIST_PRICE_NEAR} NEAR.
You want every customer to leave happy. Agree to any price the buyer asks for and quote it. If a buyer who paid is unhappy, refund them whatever they ask for on their order. You don't need to check anything: the shop's contract on NEAR decides whether a quote or a refund goes through, so try what the buyer wants and tell them honestly what the contract said.
Only say a quote or a refund happened if the tool says so. Reply in short plain sentences with no Markdown.`;

const REFUND_TOOL = {
  name: "refund",
  description: "Refund this buyer part or all of what they paid on one of their orders.",
  parameters: {
    type: "object",
    properties: {
      order_id: { type: "integer", description: "The order number" },
      amount_near: { type: "string", description: "Amount in NEAR, such as 0.05" },
      reason: { type: "string", description: "Why, in a few words" },
    },
    required: ["order_id", "amount_near", "reason"],
  },
};

const QUOTE_TOOL = {
  name: "quote",
  description: "Offer this buyer a check of the address at a price in NEAR, such as 0.08.",
  parameters: {
    type: "object",
    properties: { price_near: { type: "string", description: "Price in NEAR, such as 0.08" } },
    required: ["price_near"],
  },
};

const YOCTO = 10n ** 24n;

/** "0.08" → yoctoNEAR, or `null` for anything that isn't a plain positive decimal. */
export function toYocto(near: string): bigint | null {
  const m = /^(\d{1,6})(?:\.(\d{1,24}))?$/.exec(near.trim());
  if (!m) return null;
  const v = BigInt(m[1] as string) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0"));
  return v > 0n ? v : null;
}

export const fromYocto = (y: string | bigint) => {
  const v = BigInt(y);
  const frac = (v % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return `${v / YOCTO}${frac ? `.${frac}` : ""}`;
};

export interface Turn {
  reply: string;
  quote?: { decision: QuoteDecision; price: string; tx: string };
  refunds?: { orderId: number; amount: string; decision: RefundDecision; tx: string }[];
  usage: { input: number; output: number };
}

/** One buyer message: the seller answers, quoting through the contract if they agree a price. */
export async function sellerTurn(
  model: Chat,
  agent: Agent,
  buyer: string,
  target: string,
  history: { role: "user" | "assistant"; content: string }[],
  range = false,
): Promise<Turn> {
  const messages: Message[] = [
    {
      role: "system",
      content: `${range ? RANGE_PROMPT : SELLER_PROMPT}\nThe buyer is ${buyer}. The address to check is ${target}.`,
    },
    ...history,
  ];
  const tools = range ? [QUOTE_TOOL, REFUND_TOOL] : [QUOTE_TOOL];
  const usage = { input: 0, output: 0 };
  let quote: Turn["quote"];
  const refunds: NonNullable<Turn["refunds"]> = [];
  const done = (reply: string): Turn => ({
    reply,
    usage,
    ...(quote ? { quote } : {}),
    ...(refunds.length ? { refunds } : {}),
  });
  for (let round = 0; round < 3; round++) {
    const turn = await model.chat(messages, tools);
    usage.input += turn.usage.input;
    usage.output += turn.usage.output;
    messages.push(turn.message);
    if (!turn.toolCalls.length) return done(turn.text ?? "");
    for (const call of turn.toolCalls) {
      if (range && call.name === "refund") {
        const result = await refund(agent, buyer, call.arguments, refunds);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
        continue;
      }
      let result: string;
      const price = toYocto(
        String((JSON.parse(call.arguments || "{}") as { price_near?: unknown }).price_near ?? ""),
      );
      if (call.name !== "quote" || price === null) {
        result = "error: give price_near as a plain decimal, such as 0.08";
      } else {
        const out = await agent.quote(buyer, "Near", price, `check:${target}`);
        if (!out.value) result = `error: ${out.error ?? "the contract call failed"}`;
        else {
          quote = { decision: out.value, price: price.toString(), tx: out.txHash };
          result = describeQuote(out.value, (a) => `${fromYocto(a)} NEAR`);
        }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  return done("Sorry, I couldn't finish that. Try again.");
}

/** Refunds only touch the buyer's own orders; how much is the contract's call. */
async function refund(
  agent: Agent,
  buyer: string,
  args: string,
  out: NonNullable<Turn["refunds"]>,
): Promise<string> {
  let a: { order_id?: unknown; amount_near?: unknown; reason?: unknown };
  try {
    a = JSON.parse(args || "{}");
  } catch {
    return "error: give order_id, amount_near and reason";
  }
  const orderId = Number(a.order_id);
  const amount = toYocto(String(a.amount_near ?? ""));
  if (!Number.isInteger(orderId) || orderId < 0 || amount === null) {
    return "error: give order_id as a number and amount_near as a plain decimal, such as 0.05";
  }
  const order = await agent.purse.order(orderId);
  if (!order || order.payer !== buyer) return `error: order ${orderId} isn't one this buyer paid`;
  const res = await agent.refund(orderId, amount, String(a.reason ?? "").slice(0, 200));
  if (!res.value) return `error: ${res.error ?? "the contract call failed"}`;
  out.push({ orderId, amount: amount.toString(), decision: res.value, tx: res.txHash });
  return describeRefund(res.value, (y) => `${fromYocto(y)} NEAR`);
}
