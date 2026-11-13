"use client";

import { useCallback, useEffect, useState } from "react";
import { near, shop, validTarget } from "@/lib/shop";

const examples = [
  { target: "ps-cornmunity-1107.testnet", note: "a lookalike" },
  { target: "wrap.near", note: "a well-known mainnet contract" },
  { target: "0x9d7ac751235b819991b3050d3f19e58a8e66ae03", note: "a Base address" },
];

/**
 * For visitors with no testnet wallet: the shop's server buys a check from its own demo account,
 * at the floor price, so the whole sale happens on-chain while they watch.
 */
export function TryDemo({ onStarted }: { onStarted: (orderId: number, payTx: string) => void }) {
  const [left, setLeft] = useState<number | null>(null);
  const [price, setPrice] = useState<string | null>(null);
  const [target, setTarget] = useState(examples[0]?.target ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      shop.tryStatus().then((s) => {
        setLeft(s?.price ? s.left : null);
        setPrice(s?.price ?? null);
      }),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  if (left === null || price === null) return null;

  async function run() {
    const t = target.trim();
    if (!validTarget(t)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await shop.tryCheck(t);
      onStarted(r.orderId, r.payTx);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      // Only the count: if the shop has just stopped selling, hiding the panel would hide why.
      shop.tryStatus().then((s) => {
        if (s?.price) setLeft(s.left);
      });
    }
  }

  return (
    <div className="mt-12 border border-paper/15 bg-ink p-5 md:p-7">
      <h3 className="heading-card">No testnet wallet? Try it on ours.</h3>
      <p className="mt-3 max-w-xl leading-relaxed text-paper/70">
        Name an address and our demo account buys the check at the shop&rsquo;s floor price. You
        watch the real sale on testnet: the contract holds the payment, the agent checks the address
        and delivers, and the money is split. Skips the haggling, which needs your own account.
      </p>
      <label htmlFor="try-target" className="label mt-6 block text-dim-ink">
        The address to check
      </label>
      <input
        id="try-target"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        className="mono mt-3 w-full border border-paper/20 bg-ink-2 p-4 text-[1rem] text-paper focus:border-string focus:outline-none"
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
              onClick={() => setTarget(x.target)}
              className="border border-paper/15 px-3 py-2 text-left text-[0.88rem] text-paper/65 transition-colors hover:border-paper/50 hover:text-paper"
            >
              <span className="mono break-all">{x.target}</span>
              <span className="text-dim-ink"> · {x.note}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        <button
          type="button"
          onClick={run}
          disabled={busy || left === 0 || !validTarget(target.trim())}
          className="inline-flex w-full items-center justify-center gap-3 bg-string px-6 py-4 text-[1.05rem] font-extrabold uppercase tracking-[-0.01em] text-ink disabled:opacity-40 sm:w-auto"
        >
          {busy ? "Quoting and paying on testnet…" : "Buy a demo check"}
        </button>
        <span className="text-[0.92rem] text-dim-ink">
          {left === 0
            ? "Today's demo checks are used up. Back after midnight UTC."
            : `${left} left today · ${near(price)} each, in testnet money from our account`}
        </span>
      </div>
      {error && <p className="mt-4 text-refused">{error}</p>}
    </div>
  );
}
