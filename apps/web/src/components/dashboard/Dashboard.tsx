"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { gsap, reducedMotion, revealLines, useGSAP } from "@/lib/gsap";
import { duration, RANGE_ACCOUNT } from "@/lib/policy";
import { type Snapshot, snapshot } from "@/lib/purse";
import { connectAccount, connectedAccount, disconnect, ownerCall } from "@/lib/wallet";
import { Block } from "../Block";
import { Stats } from "../Stats";
import { Editor } from "./Editor";
import {
  type Act,
  Agents,
  Budgets,
  Button,
  Inbox,
  lapsed,
  Queue,
  RedTeam,
  Stream,
  waiting,
} from "./parts";

const nowS = () => Math.floor(Date.now() / 1000);

const clock = (s: number) =>
  new Date(s * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// A proposal can apply stricter parts at once and queue the looser ones, so the message says which.
function outcome(label: string, before: Snapshot | null, after: Snapshot | null) {
  if (!before || !after) return `${label}: done.`;
  const queued = after.proposals.filter((p) => !before.proposals.some((q) => q.id === p.id));
  const applied = after.policy.version > before.policy.version;
  if (queued.length === 0) return `${label}: done.`;
  const eta = Math.max(...queued.map((p) => p.eta));
  const wait = `Looser rules wait ${duration(before.policy.timelock_s)}: from ${clock(eta)}, press Apply under Queued changes.`;
  return applied ? `Stricter parts applied now. ${wait}` : `Queued. ${wait}`;
}

function failure(message: string, before: Snapshot | null) {
  if (/panicked: expired/.test(message))
    return `the request expired before it was approved (requests wait ${before ? duration(before.policy.pending_ttl_s) : "a limited time"}), so it can't be paid. Close it to free its budget.`;
  if (/panicked: timelocked/.test(message)) return "this change is still in its waiting period.";
  if (/panicked: frozen/.test(message)) return "the account is frozen.";
  const panic = message.match(/panicked: ([^"}]+)/);
  return panic ? `the contract refused: ${panic[1]}.` : message;
}

export function Dashboard() {
  const root = useRef<HTMLDivElement>(null);
  const [account, setAccount] = useState(RANGE_ACCOUNT);
  const [draft, setDraft] = useState(RANGE_ACCOUNT);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(nowS);
  // Bumped after each owner action, so the editor's drafts reset to the new policy.
  const [version, setVersion] = useState(0);

  const load = useCallback(async (id: string) => {
    try {
      const next = await snapshot(id);
      setSnap(next);
      setLoadError(null);
      return next;
    } catch (e) {
      setLoadError(
        /does not exist|doesn't exist|UNKNOWN_ACCOUNT/i.test((e as Error).message)
          ? `${id} doesn't exist on testnet.`
          : /MethodNotFound|CodeDoesNotExist|wasm/i.test((e as Error).message)
            ? `${id} isn't a Pursestrings account.`
            : (e as Error).message,
      );
      setSnap(null);
      return null;
    }
  }, []);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("purse");
    const id = fromUrl ?? RANGE_ACCOUNT;
    setAccount(id);
    setDraft(id);
    connectedAccount().then(setMe);
  }, []);

  useEffect(() => {
    load(account);
    const t = setInterval(() => {
      if (document.hidden) return;
      setNow(nowS());
      load(account);
    }, 15_000);
    return () => clearInterval(t);
  }, [account, load]);

  useGSAP(
    (_, contextSafe) => {
      if (reducedMotion()) return;
      let split: ReturnType<typeof revealLines> | undefined;
      const start = contextSafe?.(() => {
        split = revealLines(".dash-title", { stagger: 0.1 });
        gsap.fromTo(
          ".dash-fade",
          { y: 24, autoAlpha: 0 },
          { y: 0, autoAlpha: 1, stagger: 0.08, duration: 0.9, ease: "expo.out", delay: 0.35 },
        );
      });
      document.fonts.ready.then(() => start?.());
      return () => split?.revert();
    },
    { scope: root },
  );

  const owner = !!snap && me === snap.owner;

  const act: Act = async (label, method, args = {}) => {
    setBusy(label);
    setNotice(null);
    const before = snap;
    try {
      await ownerCall(account, method, args, { deposit: method === "expire_request" ? "0" : "1" });
      const after = await load(account);
      setVersion((v) => v + 1);
      setNotice({ ok: true, text: outcome(label, before, after) });
    } catch (e) {
      setNotice({ ok: false, text: `${label}: ${failure((e as Error).message, before)}` });
    } finally {
      setBusy(null);
    }
  };

  const open = (e: React.FormEvent) => {
    e.preventDefault();
    const id = draft.trim().toLowerCase();
    if (!id) return;
    setAccount(id);
    window.history.replaceState(null, "", `?purse=${encodeURIComponent(id)}`);
  };

  const pending = snap?.requests?.filter((r) => waiting(r.req) && !lapsed(r.req, now)).length ?? 0;

  const stats = snap
    ? [
        {
          label: "Status",
          value: snap.policy.frozen ? "Frozen" : "Active",
          dot: snap.policy.frozen ? "bg-refused" : "bg-paid",
        },
        { label: "Waiting for you", value: snap.requests ? String(pending) : "–" },
        { label: "Queued changes", value: String(snap.proposals.length) },
        { label: "Policy version", value: String(snap.policy.version) },
      ]
    : [];

  return (
    <div ref={root} className="surface-ink grain relative">
      <header className="px-5 pb-16 pt-32 md:px-10 md:pb-24 md:pt-44">
        <p className="dash-fade reveal eyebrow flex items-center gap-3 text-dim-ink">
          <span className="h-2 w-2 bg-string" />
          Dashboard · NEAR testnet
        </p>
        <h1 className="dash-title reveal display mt-8 text-[clamp(2.4rem,10vw,4.5rem)] md:text-[clamp(4rem,7.6vw,8.5rem)]">
          Hold <span className="text-string">the strings.</span>
        </h1>
        <p className="dash-fade reveal mt-10 max-w-2xl text-[1.1rem] leading-relaxed text-paper/75 md:text-[1.25rem]">
          What a Pursestrings account allows, spends and waits on, read live from the chain. Anyone
          can look. Connect the owner&rsquo;s wallet to approve payments, change limits or freeze
          everything.
        </p>

        <div className="dash-fade reveal mt-12 grid gap-8 lg:grid-cols-2 lg:gap-16">
          <form onSubmit={open} className="flex flex-col gap-3">
            <label htmlFor="purse" className="eyebrow text-dim-ink">
              Pursestrings account
            </label>
            <div className="flex gap-3">
              <input
                id="purse"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="mono w-full min-w-0 border border-paper/20 bg-ink-2 px-4 py-3 text-[0.95rem] text-paper focus:border-string focus:outline-none"
              />
              <button
                type="submit"
                className="eyebrow shrink-0 border border-paper/40 px-4 transition-colors hover:bg-paper hover:text-ink"
              >
                Open
              </button>
            </div>
          </form>
          <div className="flex flex-col gap-3">
            <p className="eyebrow text-dim-ink">Your wallet</p>
            {me ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <span className="mono break-all text-[0.95rem]">{me}</span>
                <span
                  className={`eyebrow border px-2 py-1 text-[0.65rem] ${owner ? "border-paid text-paid" : "border-paper/30 text-paper/60"}`}
                >
                  {owner ? "Owner" : "Read only"}
                </span>
                <button
                  type="button"
                  onClick={() => disconnect().then(() => setMe(null))}
                  className="eyebrow text-dim-ink hover:text-paper"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <div>
                <Button
                  onClick={() =>
                    connectAccount()
                      .then(setMe)
                      .catch(() => {})
                  }
                >
                  Connect a testnet wallet
                </Button>
              </div>
            )}
            {snap && !owner && (
              <p className="text-[0.95rem] text-paper/55">
                Only <span className="mono break-all text-paper/80">{snap.owner}</span> can make
                changes here.
              </p>
            )}
          </div>
        </div>

        {loadError && <p className="mt-10 text-refused">{loadError}</p>}

        {snap && <Stats stats={stats} className="mt-16 md:mt-20" />}
      </header>

      {(busy || notice) && (
        <div
          role="status"
          className="fixed inset-x-5 bottom-5 z-40 mx-auto max-w-xl border border-paper/20 bg-ink-2 px-5 py-4 shadow-[0_10px_40px_rgba(0,0,0,0.5)] md:inset-x-10"
        >
          {busy ? (
            <p className="text-paper/80">{busy}: confirm it in your wallet…</p>
          ) : (
            notice && (
              <div className="flex items-start justify-between gap-4">
                <p className={`break-words ${notice.ok ? "text-paid" : "text-refused"}`}>
                  {notice.text}
                </p>
                <button
                  type="button"
                  onClick={() => setNotice(null)}
                  className="eyebrow shrink-0 text-dim-ink hover:text-paper"
                >
                  Close
                </button>
              </div>
            )
          )}
        </div>
      )}

      {snap && (
        <>
          <Block
            label="Kill switch"
            intro="Freezing refuses every request at once. Unfreezing waits out the timelock."
            className="border-t border-paper/15"
          >
            <div className="flex flex-col gap-10">
              <div className="flex flex-wrap items-center gap-4">
                {snap.policy.frozen ? (
                  <>
                    <p className="text-[1.1rem] text-refused">Frozen: every request is refused.</p>
                    <Button
                      disabled={!owner || !!busy}
                      onClick={() => act("Unfreeze", "propose", { ops: ["Unfreeze"] })}
                    >
                      Unfreeze (waits {duration(snap.policy.timelock_s)})
                    </Button>
                  </>
                ) : (
                  <Button
                    tone="stop"
                    disabled={!owner || !!busy}
                    onClick={() => act("Freeze", "freeze")}
                  >
                    Freeze everything now
                  </Button>
                )}
              </div>
              <div>
                <h3 className="eyebrow text-dim-ink">Agent keys</h3>
                <div className="mt-4">
                  <Agents snap={snap} owner={owner && !busy} act={act} />
                </div>
              </div>
            </div>
          </Block>

          <Block
            label="Waiting for you"
            intro="Payments over a co-sign line. Each one's budget is held until you decide or it expires."
            className="border-t border-paper/15"
          >
            <Inbox snap={snap} owner={owner && !busy} act={act} now={now} />
          </Block>

          <Block
            label="Budgets"
            intro="Rolling windows per asset. Approved and held payments both count."
            className="border-t border-paper/15"
          >
            <Budgets snap={snap} />
          </Block>

          <Block
            id="edit"
            label="Change the policy"
            intro="Edit, read the changes back in plain words, then sign once."
            className="border-y border-paper/15 bg-ink-2"
          >
            <Editor
              key={`${account}-${version}`}
              policy={snap.policy}
              owner={owner && !busy}
              act={act}
            />
          </Block>

          <Block
            label="Timelock queue"
            intro={`Looser changes wait ${duration(snap.policy.timelock_s)} before anyone can apply them, so a stolen owner key can't loosen anything quietly.`}
          >
            <Queue snap={snap} owner={owner && !busy} act={act} now={now} />
          </Block>

          <Block
            label="Payments"
            intro="Everything the contract let through or held, newest first."
            className="border-t border-paper/15"
          >
            <Stream snap={snap} now={now} />
          </Block>

          <Block
            label="Red team"
            intro="Six attacks that CI runs against a fresh account on every push, with the same result each time."
            className="border-t border-paper/15"
          >
            <RedTeam />
          </Block>
        </>
      )}
    </div>
  );
}
