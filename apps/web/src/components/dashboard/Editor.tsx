"use client";

import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { describe, type Op, tightens } from "@/lib/ops";
import {
  amount,
  assetInfo,
  chainName,
  duration,
  fromRaw,
  type Policy,
  type Recipient,
  type Rule,
  recipientName,
  span,
  toRaw,
} from "@/lib/policy";
import { recipientKey } from "@/lib/purse";
import { type Act, Button } from "./parts";

interface RuleDraft {
  perTx: string;
  windows: string[];
  cosign: string;
}

function draftOf(r: Rule): RuleDraft {
  const { decimals } = assetInfo(r.asset);
  return {
    perTx: fromRaw(r.per_tx_cap, decimals),
    windows: r.windows.map((w) => fromRaw(w.limit, decimals)),
    cosign: r.cosign_above === null ? "" : fromRaw(r.cosign_above, decimals),
  };
}

/** Turns the drafts into ops, one per real change; throws with a readable message on bad input. */
function build(
  p: Policy,
  rules: RuleDraft[],
  removed: Set<string>,
  added: Recipient[],
  velocity: string,
): Op[] {
  const ops: Op[] = [];
  p.assets.forEach((cur, i) => {
    const d = rules[i];
    if (!d) return;
    const { name, decimals } = assetInfo(cur.asset);
    const raw = (v: string, what: string) => {
      try {
        return toRaw(v, decimals);
      } catch (e) {
        throw new Error(`${name}, ${what}: ${(e as Error).message}`);
      }
    };
    const next: Rule = {
      ...cur,
      per_tx_cap: raw(d.perTx, "largest payment"),
      windows: cur.windows.map((w, j) => ({
        ...w,
        limit: raw(d.windows[j] ?? "", `limit per ${span(w.period_s)}`),
      })),
      cosign_above: d.cosign.trim() === "" ? null : raw(d.cosign, "co-sign line"),
    };
    if (JSON.stringify(next) !== JSON.stringify(cur)) ops.push({ SetAssetRule: next });
  });
  for (const r of p.recipients) if (removed.has(recipientKey(r))) ops.push({ RemoveRecipient: r });
  for (const r of added) ops.push({ AddRecipient: r });
  const v = velocity.trim();
  const period = p.velocity?.period_s ?? 3_600;
  const nextV = v === "" ? null : { max: Number(v), period_s: period };
  if (nextV && (!Number.isInteger(nextV.max) || nextV.max < 1))
    throw new Error("Payments per period must be a whole number, 1 or more");
  if (JSON.stringify(nextV) !== JSON.stringify(p.velocity))
    ops.push({ SetVelocity: { velocity: nextV } });
  return ops;
}

const input =
  "w-full min-w-0 border border-paper/20 bg-ink px-3 py-2.5 text-paper placeholder:text-dim-ink focus:border-string focus:outline-none";

export function Editor({ policy, owner, act }: { policy: Policy; owner: boolean; act: Act }) {
  const fresh = () => ({
    rules: policy.assets.map(draftOf),
    removed: new Set<string>(),
    added: [] as Recipient[],
    velocity: policy.velocity ? String(policy.velocity.max) : "",
  });
  const [d, setD] = useState(fresh);
  const [kind, setKind] = useState<"near" | number>("near");
  const [who, setWho] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const result = useMemo(() => {
    try {
      return { ops: build(policy, d.rules, d.removed, d.added, d.velocity), error: null };
    } catch (e) {
      return { ops: [] as Op[], error: (e as Error).message };
    }
  }, [policy, d]);

  const setRule = (i: number, patch: Partial<RuleDraft>) =>
    setD((s) => ({ ...s, rules: s.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const add = () => {
    const v = who.trim();
    setAddError(null);
    let r: Recipient;
    if (kind === "near") {
      if (!/^[a-z0-9._-]{2,64}$/.test(v)) return setAddError("That isn't a NEAR account id");
      r = { Near: { account: v } };
    } else {
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return setAddError("That isn't a 0x address");
      r = { Evm: { chain_id: kind, address: v.toLowerCase() } };
    }
    if ([...policy.recipients, ...d.added].some((x) => recipientKey(x) === recipientKey(r)))
      return setAddError("Already allowed");
    setD((s) => ({ ...s, added: [...s.added, r] }));
    setWho("");
  };

  const toggle = (r: Recipient) =>
    setD((s) => {
      const removed = new Set(s.removed);
      const k = recipientKey(r);
      if (removed.has(k)) removed.delete(k);
      else removed.add(k);
      return { ...s, removed };
    });

  return (
    <div className="flex flex-col gap-14">
      <div>
        <h3 className="eyebrow text-dim-ink">Limits per asset</h3>
        <p className="mt-2 text-[0.95rem] text-paper/55">
          In whole units. Leave the co-sign line empty to never ask you.
        </p>
        <div className="mt-6 flex flex-col gap-8">
          {policy.assets.map((r, i) => {
            const { name, decimals } = assetInfo(r.asset);
            const dr = d.rules[i];
            if (!dr) return null;
            return (
              <fieldset key={JSON.stringify(r.asset)} className="border-t border-paper/15 pt-5">
                <legend className="pr-3 font-bold">{name}</legend>
                <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <label className="flex flex-col gap-2">
                    <span className="text-[0.9rem] text-paper/60">Largest payment</span>
                    <input
                      className={input}
                      inputMode="decimal"
                      value={dr.perTx}
                      onChange={(e) => setRule(i, { perTx: e.target.value })}
                    />
                  </label>
                  {r.windows.map((w, j) => (
                    <label key={w.period_s} className="flex flex-col gap-2">
                      <span className="text-[0.9rem] text-paper/60">
                        Limit per {span(w.period_s)}
                      </span>
                      <input
                        className={input}
                        inputMode="decimal"
                        value={dr.windows[j] ?? ""}
                        onChange={(e) =>
                          setRule(i, {
                            windows: dr.windows.map((x, k) => (k === j ? e.target.value : x)),
                          })
                        }
                      />
                    </label>
                  ))}
                  <label className="flex flex-col gap-2">
                    <span className="text-[0.9rem] text-paper/60">Ask me above</span>
                    <input
                      className={input}
                      inputMode="decimal"
                      placeholder="never"
                      value={dr.cosign}
                      onChange={(e) => setRule(i, { cosign: e.target.value })}
                    />
                  </label>
                </div>
                <p className="mt-2 text-[0.85rem] text-dim-ink">
                  Now: largest {amount(r.per_tx_cap, decimals)}
                  {r.windows.map((w) => `, ${amount(w.limit, decimals)} per ${span(w.period_s)}`)}
                  {r.cosign_above ? `, ask above ${amount(r.cosign_above, decimals)}` : ""}
                </p>
              </fieldset>
            );
          })}
        </div>
      </div>

      <div>
        <h3 className="eyebrow text-dim-ink">Who it may pay</h3>
        <p className="mt-2 text-[0.9rem] text-paper/60">
          The only places money can go. A NEAR account looks like shop.testnet; an address on
          another chain looks like 0x… and is paid through Chain Signatures.
        </p>
        <ul className="mt-4 flex flex-col gap-2">
          {[...policy.recipients, ...d.added].map((r) => {
            const k = recipientKey(r);
            const isNew = d.added.some((x) => recipientKey(x) === k);
            const gone = d.removed.has(k);
            return (
              <li
                key={k}
                className="flex flex-wrap items-center justify-between gap-3 border border-paper/15 px-4 py-3"
              >
                <span
                  className={`mono min-w-0 break-all text-[0.9rem] ${gone ? "text-refused line-through" : isNew ? "text-paid" : ""}`}
                >
                  {recipientName(r)}
                </span>
                <button
                  type="button"
                  className="eyebrow text-dim-ink hover:text-paper"
                  onClick={() =>
                    isNew
                      ? setD((s) => ({ ...s, added: s.added.filter((x) => recipientKey(x) !== k) }))
                      : toggle(r)
                  }
                >
                  {isNew ? "Undo" : gone ? "Keep" : "Remove"}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
          <div className="relative">
            <select
              aria-label="Where the recipient is"
              className={`${input} cursor-pointer appearance-none pr-10`}
              value={String(kind)}
              onChange={(e) => setKind(e.target.value === "near" ? "near" : Number(e.target.value))}
            >
              <option value="near">On NEAR</option>
              {policy.chains.map((c) => (
                <option key={c} value={c}>
                  On {chainName(c)}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-dim-ink"
            />
          </div>
          <input
            aria-label="Recipient"
            className={`${input} mono text-[0.9rem]`}
            placeholder={kind === "near" ? "shop.testnet" : "0x…"}
            value={who}
            onChange={(e) => setWho(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <Button onClick={add}>Add</Button>
        </div>
        {addError && <p className="mt-2 text-[0.9rem] text-refused">{addError}</p>}
      </div>

      <div>
        <h3 className="eyebrow text-dim-ink">How often</h3>
        <label className="mt-4 flex max-w-sm flex-col gap-2">
          <span className="text-[0.9rem] text-paper/60">
            Most payments per {span(policy.velocity?.period_s ?? 3_600)}
          </span>
          <input
            className={input}
            inputMode="numeric"
            placeholder="no limit"
            value={d.velocity}
            onChange={(e) => setD((s) => ({ ...s, velocity: e.target.value }))}
          />
        </label>
      </div>

      <div className="border border-paper/20 bg-ink p-5 md:p-7">
        <h3 className="eyebrow text-dim-ink">Read back before you sign</h3>
        {result.error ? (
          <p className="mt-4 text-refused">{result.error}</p>
        ) : result.ops.length === 0 ? (
          <p className="mt-4 text-paper/60">No changes yet.</p>
        ) : (
          <>
            <ul className="mt-5 flex flex-col gap-4">
              {result.ops.map((op) => {
                const now = tightens(op, policy);
                return (
                  <li
                    key={JSON.stringify(op)}
                    className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-6"
                  >
                    <span className="wrap-break-word leading-relaxed">{describe(op)}</span>
                    <span className={`eyebrow ${now ? "text-paid" : "text-wait"}`}>
                      {now ? "Applies now" : `Waits ${duration(policy.timelock_s)}`}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-6 text-[0.9rem] text-paper/50">
              Stricter changes apply as soon as you sign. Looser ones wait in the queue below, where
              you can cancel them. The contract makes the final call on which is which.
            </p>
          </>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button
            tone="go"
            disabled={!owner || result.ops.length === 0 || result.ops.length > 32}
            onClick={() => act("Change the policy", "propose", { ops: result.ops })}
          >
            Sign and submit
          </Button>
          <Button onClick={() => setD(fresh())}>Reset</Button>
        </div>
      </div>
    </div>
  );
}
