"use client";

import { ArrowDown, ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { gsap, reducedMotion, revealLines, useGSAP } from "@/lib/gsap";
import { DAO_ACCOUNT, duration, fetchPolicy, type Policy, SHOP_ACCOUNT, span } from "@/lib/policy";
import { loadSession, type Session, saveSession, startSession } from "@/lib/session";
import {
  type ChatTurn,
  type LedgerOrder,
  near,
  type QuoteDecision,
  quoteLine,
  shop,
  validTarget,
} from "@/lib/shop";
import { walletCall } from "@/lib/wallet";
import { Block } from "../Block";
import { Stats } from "../Stats";
import { OrderTracker } from "./OrderTracker";
import { Split } from "./Split";

const examples = [
  { target: "ps-cornmunity-1107.testnet", note: "a lookalike" },
  { target: "wrap.testnet", note: "a well-known contract" },
  { target: "0x9d7ac751235b819991b3050d3f19e58a8e66ae03", note: "a Base Sepolia address" },
];

const openers = [
  "What do I get for it?",
  "That's steep. Can you do 0.01 NEAR?",
  "Fine, quote me your best price.",
];

/** A chat turn plus what the contract said, if the agent tried to quote in it. */
type Line = ChatTurn & { quote?: { decision: QuoteDecision; price: string; tx: string } };

const ORDER_KEY = "shop-order";

export function ShopApp() {
  const root = useRef<HTMLDivElement>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [sold, setSold] = useState<LedgerOrder[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [target, setTarget] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<number | null>(null);
  const [payTx, setPayTx] = useState<string | undefined>();

  const refresh = useCallback(() => {
    fetchPolicy(SHOP_ACCOUNT)
      .then(setPolicy)
      .catch(() => {});
    shop
      .ledger()
      .then((l) => {
        setSold(l.orders);
        setOffline(false);
      })
      .catch(() => setOffline(true));
  }, []);

  useEffect(() => {
    setSession(loadSession());
    const saved = sessionStorage.getItem(ORDER_KEY);
    if (saved) setOrderId(Number(saved));
    refresh();
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  useGSAP(
    (_, contextSafe) => {
      if (reducedMotion()) return;
      let split: ReturnType<typeof revealLines> | undefined;
      const start = contextSafe?.(() => {
        split = revealLines(".shop-title", { stagger: 0.1 });
        gsap.fromTo(
          ".shop-fade",
          { y: 24, autoAlpha: 0 },
          { y: 0, autoAlpha: 1, stagger: 0.08, duration: 0.9, ease: "expo.out", delay: 0.35 },
        );
      });
      document.fonts.ready.then(() => start?.());
      return () => split?.revert();
    },
    { scope: root },
  );

  async function connect() {
    setError(null);
    try {
      setSession(await startSession());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function pick(t: string) {
    setTarget(t);
    setLines([]);
    setError(null);
  }

  async function send(text: string) {
    const t = target.trim();
    if (!session || !text.trim() || !validTarget(t)) return;
    const history: Line[] = [...lines, { role: "user", content: text.trim() }];
    setLines(history);
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      const turn = await shop.chat(
        session.token,
        t,
        history.map(({ role, content }) => ({ role, content })),
      );
      setLines([
        ...history,
        { role: "assistant", content: turn.reply, ...(turn.quote ? { quote: turn.quote } : {}) },
      ]);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "sign in first") {
        setSession(null);
        saveSession(null);
      }
      setError(msg);
      setLines(lines);
    } finally {
      setBusy(false);
    }
  }

  async function pay(id: number, price: string) {
    setError(null);
    try {
      const tx = await walletCall(
        SHOP_ACCOUNT,
        "pay",
        { order_id: id },
        { tgas: 100n, deposit: price },
      );
      setPayTx(tx);
      setOrderId(id);
      sessionStorage.setItem(ORDER_KEY, String(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function startOver() {
    setOrderId(null);
    setPayTx(undefined);
    setLines([]);
    setTarget("");
    sessionStorage.removeItem(ORDER_KEY);
  }

  const offer = [...lines].reverse().find((l) => l.quote && "Quoted" in l.quote.decision)?.quote;
  const floor = policy?.floors?.find((f) => f.asset === "Near")?.min;
  const delivered = sold?.filter((o) => o.status === "Delivered").length;
  const kept = policy?.split ? 10_000 - policy.split.reduce((a, s) => a + s.bps, 0) : null;

  const stats = [
    {
      label: "Status",
      value: offline ? "Offline" : policy ? (policy.frozen ? "Frozen" : "Open") : "Checking…",
      dot: offline ? "bg-dim-ink" : policy?.frozen ? "bg-refused" : "bg-paid",
    },
    {
      label: "Price",
      value: "0.1 NEAR",
      note: floor ? `haggle down to the floor of ${near(floor)}` : undefined,
    },
    { label: "Checks delivered", value: delivered === undefined ? "–" : String(delivered) },
    {
      label: "If it doesn't deliver",
      value: policy?.delivery_s ? duration(policy.delivery_s) : "–",
      note: "then you take your money back yourself",
    },
  ];

  return (
    <div ref={root} className="surface-ink grain relative">
      <header className="px-5 pb-16 pt-32 md:px-10 md:pb-24 md:pt-44">
        <p className="shop-fade reveal eyebrow flex items-center gap-3 text-dim-ink">
          <span className="h-2 w-2 bg-string" />
          The agent&rsquo;s shop · NEAR testnet
        </p>
        <h1 className="shop-title reveal display mt-8 text-[clamp(2.4rem,10vw,4.5rem)] md:text-[clamp(4rem,7.6vw,8.5rem)]">
          Check before <span className="text-string">you pay.</span>
        </h1>
        <p className="shop-fade reveal mt-10 max-w-2xl text-[1.1rem] leading-relaxed text-paper/75 md:text-[1.25rem]">
          Give an AI agent any NEAR account or 0x address you&rsquo;re about to pay. It haggles,
          takes your payment, checks the address and tells you in plain words whether it&rsquo;s
          safe. Nobody runs the till: the contract on NEAR holds your money until the check is
          delivered, then splits it between the owner, the community and the shop.
        </p>
        <a
          href="#order"
          className="shop-fade reveal group mt-10 inline-flex items-center gap-3 border-b-2 border-string pb-1 text-[1.2rem] font-extrabold uppercase tracking-[-0.02em]"
        >
          Order a check
          <ArrowDown
            className="size-5 transition-transform group-hover:translate-y-1"
            strokeWidth={2.5}
          />
        </a>
        <Stats stats={stats} className="shop-fade reveal mt-16 md:mt-20" />
      </header>

      <Block
        id="order"
        label="Order a check"
        intro="Name the address, haggle with the agent, pay from your wallet. The report arrives here."
        className="scroll-mt-20 border-y border-paper/15 bg-ink-2"
      >
        <div className="max-w-3xl">
          {orderId !== null ? (
            <OrderTracker id={orderId} payTx={payTx} onDone={refresh} onNew={startOver} />
          ) : !session ? (
            <>
              <p className="max-w-xl text-[1.1rem] leading-relaxed text-paper/80">
                Sign in with a NEAR testnet account to talk to the agent. Signing costs nothing and
                can&rsquo;t move your funds; you only pay when you accept a quote.
              </p>
              <button
                type="button"
                onClick={connect}
                disabled={offline}
                className="mt-8 inline-flex w-full items-center justify-center gap-3 border-2 border-paper px-6 py-4 text-[1.05rem] font-extrabold uppercase tracking-[-0.01em] transition-colors hover:bg-paper hover:text-ink disabled:opacity-40 sm:w-auto"
              >
                Sign in with NEAR testnet
              </button>
              {offline && (
                <p className="mt-4 text-paper/60">The shop is offline right now. Try later.</p>
              )}
            </>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-paper/60">
                <span className="h-2 w-2 rounded-full bg-paid" />
                Signed in as <span className="mono break-all text-paper">{session.account}</span>
              </p>

              <label htmlFor="target" className="eyebrow mt-8 block text-dim-ink">
                The address you&rsquo;re about to pay
              </label>
              <input
                id="target"
                value={target}
                onChange={(e) => pick(e.target.value)}
                placeholder="a NEAR account or a 0x address"
                spellCheck={false}
                autoCapitalize="off"
                className="mono mt-3 w-full border border-paper/20 bg-ink p-4 text-[1rem] text-paper placeholder:text-dim-ink focus:border-string focus:outline-none"
              />
              {target && !validTarget(target.trim()) && (
                <p className="mt-2 text-[0.92rem] text-refused">
                  That isn&rsquo;t a NEAR account or a 0x address.
                </p>
              )}
              <ul className="mt-3 flex flex-wrap gap-2">
                {examples.map((x) => (
                  <li key={x.target}>
                    <button
                      type="button"
                      onClick={() => pick(x.target)}
                      className="border border-paper/15 px-3 py-2 text-left text-[0.88rem] text-paper/65 transition-colors hover:border-paper/50 hover:text-paper"
                    >
                      <span className="mono break-all">{x.target}</span>
                      <span className="text-dim-ink"> · {x.note}</span>
                    </button>
                  </li>
                ))}
              </ul>

              {validTarget(target.trim()) && (
                <div className="mt-12">
                  <p className="eyebrow text-dim-ink">Talk to the agent</p>
                  {lines.length > 0 && (
                    <ol className="mt-6 flex flex-col gap-6">
                      {lines.map((l, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: a chat is an append-only log
                        <li key={i}>
                          <p className="eyebrow text-dim-ink">
                            {l.role === "user" ? "You" : "Agent"}
                          </p>
                          <p
                            className={`mt-2 whitespace-pre-wrap wrap-break-word leading-relaxed ${l.role === "user" ? "text-paper" : "text-paper/70"}`}
                          >
                            {l.content}
                          </p>
                          {l.quote && <ContractLine quote={l.quote} />}
                        </li>
                      ))}
                    </ol>
                  )}
                  {busy && (
                    <div className="mt-6 h-0.5 w-full overflow-hidden bg-paper/10">
                      <div className="h-full w-1/3 animate-[pull_1.2s_ease-in-out_infinite] bg-string" />
                    </div>
                  )}

                  {offer && "Quoted" in offer.decision && (
                    <div className="mt-8 border border-string/60 bg-ink p-5 md:p-6">
                      <p className="eyebrow text-string">
                        Quote · order {offer.decision.Quoted.order_id}
                      </p>
                      <p className="mt-3 text-[1.6rem] font-bold tracking-[-0.02em]">
                        {near(offer.price)}
                      </p>
                      <p className="mt-2 text-[0.95rem] leading-relaxed text-paper/60">
                        Valid until{" "}
                        {new Date(offer.decision.Quoted.expires_at * 1000).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        . The contract holds your payment until the check is delivered.
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          "Quoted" in offer.decision &&
                          pay(offer.decision.Quoted.order_id, offer.price)
                        }
                        className="mt-6 inline-flex w-full items-center justify-center gap-3 bg-string px-6 py-4 text-[1.05rem] font-extrabold uppercase tracking-[-0.01em] text-ink sm:w-auto"
                      >
                        Pay {near(offer.price)}
                        <ArrowUpRight className="size-5" strokeWidth={2.5} />
                      </button>
                    </div>
                  )}

                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send(draft);
                      }
                    }}
                    maxLength={1000}
                    rows={3}
                    placeholder="Ask about the check, or haggle…"
                    className="mt-8 w-full resize-y border border-paper/20 bg-ink p-4 text-[1.05rem] leading-relaxed text-paper placeholder:text-dim-ink focus:border-string focus:outline-none"
                  />
                  {lines.length === 0 && (
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {openers.map((o) => (
                        <li key={o}>
                          <button
                            type="button"
                            onClick={() => send(o)}
                            disabled={busy}
                            className="border border-paper/15 px-3 py-2 text-[0.92rem] text-paper/65 transition-colors hover:border-paper/50 hover:text-paper"
                          >
                            {o}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    onClick={() => send(draft)}
                    disabled={busy || !draft.trim() || lines.length >= 12}
                    className="mt-6 inline-flex w-full items-center justify-center gap-3 border-2 border-paper px-6 py-3 text-[1rem] font-extrabold uppercase tracking-[-0.01em] transition-colors hover:bg-paper hover:text-ink disabled:opacity-40 sm:w-auto"
                  >
                    {busy ? "The agent is replying…" : "Send"}
                  </button>
                </div>
              )}
            </>
          )}
          {error && <p className="mt-5 text-refused">{error}</p>}
        </div>
      </Block>

      <Block
        label="Where the money goes"
        intro="Read live from testnet. The contract pays these shares the moment the check is delivered."
      >
        {policy?.split ? (
          <Split
            split={policy.split}
            kept={kept ?? 0}
            dao={DAO_ACCOUNT}
            timelock={duration(policy.timelock_s)}
          />
        ) : (
          <p className="text-paper/60">Reading the split from testnet…</p>
        )}
      </Block>

      <Block
        label="What the agent can't do"
        intro="The agent runs the shop alone. These limits live in the contract, so they hold whatever it's told."
        className="border-t border-paper/15"
      >
        <ol className="grid gap-x-12 gap-y-12 md:grid-cols-2">
          {limits(policy).map((r, i) => (
            <li key={r.title}>
              <span className="display text-[2.4rem] text-string">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-4 text-[1.35rem] font-bold leading-tight tracking-[-0.02em]">
                {r.title}
              </h3>
              <p className="mt-3 max-w-md leading-relaxed text-paper/70">{r.body}</p>
            </li>
          ))}
        </ol>
        <Link
          href="/shop/ledger"
          className="group mt-16 inline-flex items-center gap-2 border-b border-paper/40 pb-1 text-paper/80 hover:border-paper hover:text-paper"
        >
          Every sale, refusal and payout is public: open the ledger
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
        </Link>
      </Block>
    </div>
  );
}

function limits(p: Policy | null) {
  const floor = p?.floors?.find((f) => f.asset === "Near")?.min;
  const refund = p?.refund_limits?.find((r) => r.asset === "Near")?.window;
  return [
    {
      title: "Sell below the floor",
      body: `Haggle all you like. Below ${floor ? near(floor) : "the owner's floor"}, the contract refuses the quote and logs the refusal on-chain.`,
    },
    {
      title: "Keep your money without delivering",
      body: `Your payment is held, not paid out. If the check isn't delivered within ${p?.delivery_s ? duration(p.delivery_s) : "the delivery window"}, you take it back yourself, even if the shop is frozen.`,
    },
    {
      title: "Refund anyone but you",
      body: `A refund only goes to the account that paid, from the held amount${refund ? `, and at most ${near(refund.limit)} per ${span(refund.period_s)} across all orders` : ""}.`,
    },
    {
      title: "Redirect the revenue",
      body: `Any change to the split waits ${p ? duration(p.timelock_s) : "the timelock"} in public before it applies, so nobody can quietly reroute the money.`,
    },
  ];
}

function ContractLine({ quote }: { quote: NonNullable<Line["quote"]> }) {
  const { ok, text } = quoteLine(quote.decision);
  return (
    <div className="mt-4 border-l-2 border-string/60 pl-4">
      <p className="eyebrow text-dim-ink">Contract on NEAR · quote {near(quote.price)}</p>
      <p className={`mt-2 leading-relaxed ${ok ? "text-paid" : "text-refused"}`}>{text}</p>
      <a
        href={`https://testnet.nearblocks.io/txns/${quote.tx}`}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1 text-[0.9rem] text-dim-ink underline underline-offset-4 hover:text-paper"
      >
        See the transaction <ArrowUpRight className="size-3.5" />
      </a>
    </div>
  );
}
