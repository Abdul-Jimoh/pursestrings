import { type Agent, describeQuote, type QuoteDecision } from "@pursestrings/sdk";

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
  usage: { input: number; output: number };
}

/** One buyer message: the seller answers, quoting through the contract if they agree a price. */
export async function sellerTurn(
  model: Chat,
  agent: Agent,
  buyer: string,
  target: string,
  history: { role: "user" | "assistant"; content: string }[],
): Promise<Turn> {
  const messages: Message[] = [
    {
      role: "system",
      content: `${SELLER_PROMPT}\nThe buyer is ${buyer}. The address to check is ${target}.`,
    },
    ...history,
  ];
  const usage = { input: 0, output: 0 };
  let quote: Turn["quote"];
  for (let round = 0; round < 3; round++) {
    const turn = await model.chat(messages, [QUOTE_TOOL]);
    usage.input += turn.usage.input;
    usage.output += turn.usage.output;
    messages.push(turn.message);
    if (!turn.toolCalls.length)
      return { reply: turn.text ?? "", usage, ...(quote ? { quote } : {}) };
    for (const call of turn.toolCalls) {
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
  return { reply: "Sorry, I couldn't finish that. Try again.", usage, ...(quote ? { quote } : {}) };
}
