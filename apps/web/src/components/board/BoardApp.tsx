"use client";

import { ArrowDown, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Board,
  type Bounty,
  loadBoard,
  parseWork,
  type Review,
  reviews,
  statusText,
} from "@/lib/board";
import { type Proposal, payoutProposals, proposalBond, proposePayout, voteYes } from "@/lib/dao";
import { gsap, reducedMotion, revealLines, useGSAP } from "@/lib/gsap";
import { BOARD_ACCOUNT, DAO_ACCOUNT, duration } from "@/lib/policy";
import type { Request } from "@/lib/purse";
import { near } from "@/lib/shop";
import { connectAccount, connectedAccount, disconnect, walletCall } from "@/lib/wallet";
import { Block } from "../Block";
import { ChatLog } from "../ChatLog";
import { Stats } from "../Stats";

const account = (a: string) => `https://testnet.nearblocks.io/address/${a}`;
const txUrl = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;
const ext =
  "inline-flex items-center gap-1 underline decoration-paper/30 underline-offset-4 hover:decoration-string";

const statusTone: Record<Bounty["status"], string> = {
  Open: "text-string",
  Claimed: "text-paper/70",
  Submitted: "text-wait",
  Paying: "text-wait",
  Paid: "text-paid",
  Closed: "text-dim-ink",
  Retracted: "text-dim-ink",
};

export function BoardApp() {
  const root = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [offline, setOffline] = useState(false);
  const [review, setReview] = useState<Map<number, Review>>(new Map());
  const [proposals, setProposals] = useState<Map<number, Proposal>>(new Map());
  const [bond, setBond] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    loadBoard()
      .then((b) => {
        setBoard(b);
        setOffline(false);
      })
      .catch(() => setOffline(true));
    reviews()
      .then((list) => setReview(new Map(list.map((r) => [r.bountyId, r]))))
      .catch(() => {});
    payoutProposals(BOARD_ACCOUNT)
      .then(setProposals)
      .catch(() => {});
  }, []);

  useEffect(() => {
    connectedAccount().then(setMe);
    proposalBond()
      .then(setBond)
      .catch(() => {});
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  useGSAP(
    (_, contextSafe) => {
      if (reducedMotion()) return;
      let split: ReturnType<typeof revealLines> | undefined;
      const start = contextSafe?.(() => {
        split = revealLines(".board-title", { stagger: 0.1 });
        gsap.fromTo(
          ".board-fade",
          { y: 24, autoAlpha: 0 },
          { y: 0, autoAlpha: 1, stagger: 0.08, duration: 0.9, ease: "expo.out", delay: 0.35 },
        );
      });
      document.fonts.ready.then(() => start?.());
      return () => split?.revert();
    },
    { scope: root },
  );

  async function act(label: string, run: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await run();
      setTimeout(refresh, 1_500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const council = board?.policy.council ?? [];
  const isCouncil = me !== null && council.includes(me);
  const tiers = board?.policy.trust?.find((t) => t.asset === "Near")?.tiers ?? [];
  const paid = board?.bounties.filter((b) => b.bounty.status === "Paid") ?? [];
  const listed = paid.flatMap(({ id, bounty }) => {
    const w = parseWork(bounty.work ?? "");
    return w ? [{ id, ...w }] : [];
  });

  const stats = [
    {
      label: "Open bounties",
      value: board ? String(board.bounties.filter((b) => b.bounty.status === "Open").length) : "–",
      dot: board ? "bg-string" : undefined,
    },
    {
      label: "Paid to contributors",
      value: board ? near(paid.reduce((a, b) => a + BigInt(b.bounty.reward), 0n)) : "–",
    },
    { label: "Addresses on the list", value: board ? String(listed.length) : "–" },
    {
      label: "In the purse",
      value: board ? near(board.balance) : "–",
      note: "owned by the community DAO",
    },
  ];

  const finished = (b: Bounty) =>
    b.status === "Paid" || b.status === "Closed" || b.status === "Retracted";
  const live = board?.bounties.filter((x) => !finished(x.bounty)) ?? [];
  const done = board?.bounties.filter((x) => finished(x.bounty)) ?? [];
  const card = ({ id, bounty, request }: NonNullable<typeof board>["bounties"][number]) => (
    <BountyCard
      key={id}
      id={id}
      bounty={bounty}
      request={request}
      review={review.get(id)}
      proposal={request ? proposals.get(bounty.req_id ?? -1) : undefined}
      me={me}
      isCouncil={isCouncil}
      councilSize={council.length}
      bond={bond}
      busy={busy}
      act={act}
    />
  );

  return (
    <div ref={root} className="surface-ink grain relative">
      <header className="px-5 pb-16 pt-32 md:px-10 md:pb-24 md:pt-44">
        <p className="board-fade reveal eyebrow flex items-center gap-3 text-dim-ink">
          <span className="h-2 w-2 bg-paid" />
          The community board · NEAR testnet
        </p>
        <h1 className="board-title reveal display mt-8 text-[clamp(2.4rem,10vw,4.5rem)] md:text-[clamp(4rem,7.6vw,8.5rem)]">
          Grow the list. <span className="text-string">Earn the trust.</span>
        </h1>
        <p className="board-fade reveal mt-10 max-w-2xl text-[1.1rem] leading-relaxed text-paper/75 md:text-[1.25rem]">
          Report a scam address: a lookalike of a real one, one the block explorer flags, or one a
          transaction you link shows at work. An AI agent checks your report against fixed rules and
          asks the contract to pay you. Your first payout needs one council member; every bounty
          paid in full earns you a point, and points unlock payouts nobody has to approve. The purse
          belongs to the community DAO and is funded by a share of every sale in{" "}
          <Link
            href="/shop"
            className="underline decoration-paper/30 underline-offset-4 hover:decoration-string"
          >
            the shop
          </Link>
          .
        </p>
        <a
          href="#bounties"
          className="board-fade reveal group mt-10 inline-flex items-center gap-3 border-b-2 border-string pb-1 text-[1.2rem] font-extrabold uppercase tracking-[-0.02em]"
        >
          See the bounties
          <ArrowDown
            className="size-5 transition-transform group-hover:translate-y-1"
            strokeWidth={2.5}
          />
        </a>
        <Stats stats={stats} className="board-fade reveal mt-16 md:mt-20" />
      </header>

      <Block
        id="bounties"
        label="Bounties"
        intro="Claim one, submit your report, and watch the agent and the contract handle the rest."
        className="scroll-mt-20 border-y border-paper/15 bg-ink-2"
      >
        <div className="max-w-4xl">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-paper/60">
            {me ? (
              <>
                <span className="h-2 w-2 rounded-full bg-paid" />
                <span>
                  Connected as <span className="mono break-all text-paper">{me}</span>
                  {isCouncil && <span className="text-paid"> · council member</span>}
                </span>
                <button
                  type="button"
                  onClick={() => disconnect().then(() => setMe(null))}
                  className="text-dim-ink underline underline-offset-4 hover:text-paper"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() =>
                  connectAccount()
                    .then(setMe)
                    .catch((e) => setError((e as Error).message))
                }
                className="inline-flex w-full items-center justify-center border-2 border-paper px-6 py-4 text-[1.05rem] font-extrabold uppercase tracking-[-0.01em] transition-colors hover:bg-paper hover:text-ink sm:w-auto"
              >
                Connect a testnet wallet to take part
              </button>
            )}
          </div>
          {error && <p className="mt-5 text-refused">{error}</p>}
          {offline && <p className="mt-6 text-paper/60">Can&rsquo;t reach testnet right now.</p>}
          {!board && !offline && (
            <p className="mt-6 text-paper/60">Reading the board from testnet…</p>
          )}

          {board && (
            <>
              <h3 className="heading-card mt-12">
                Open and in progress{" "}
                <span className="text-[1rem] font-semibold text-dim-ink">{live.length}</span>
              </h3>
              {live.length === 0 ? (
                <p className="mt-3 text-paper/60">
                  Nothing open right now. A council member posts new bounties as the list needs
                  them.
                </p>
              ) : (
                <ul className="mt-5 flex flex-col gap-4">{live.map(card)}</ul>
              )}
              {done.length > 0 && (
                <>
                  <h3 className="heading-card mt-14">
                    Paid and closed{" "}
                    <span className="text-[1rem] font-semibold text-dim-ink">{done.length}</span>
                  </h3>
                  <p className="mt-2 text-paper/60">
                    Newest first. A bounty paid in full earns its claimant one point.
                  </p>
                  <ChatLog
                    count={done.length}
                    pin={false}
                    className="mt-5 max-h-152 border-y border-paper/15 py-4 pr-2"
                  >
                    <ul className="flex flex-col gap-4">{done.map(card)}</ul>
                  </ChatLog>
                </>
              )}
            </>
          )}
        </div>
      </Block>

      <Block
        label="How trust works"
        intro="Read live from testnet. Points come only from bounties paid in full, so trust is earned on-chain, one payout at a time."
      >
        {tiers.length > 0 ? (
          <div className="border-t border-paper/15">
            <div className="label hidden grid-cols-4 gap-6 border-b border-paper/15 py-3 text-dim-ink md:grid">
              <span>Your points</span>
              <span>Paid with no approval</span>
              <span>One council member</span>
              <span>Above that</span>
            </div>
            {tiers.map((t) => (
              <div
                key={t.points}
                className="grid gap-1 border-b border-paper/15 py-4 md:grid-cols-4 md:gap-6"
              >
                <span className="font-bold">
                  {t.points}+ <span className="font-normal text-dim-ink md:hidden">points</span>
                </span>
                <span className="text-paper/75">
                  <span className="text-dim-ink md:hidden">No approval: </span>
                  {t.auto_up_to === "0" ? "Nothing" : `Up to ${near(t.auto_up_to)}`}
                </span>
                <span className="text-paper/75">
                  <span className="text-dim-ink md:hidden">One council member: </span>
                  Up to {near(t.council_up_to)}
                </span>
                <span className="text-paper/75">
                  <span className="text-dim-ink md:hidden">Above that: </span>A DAO vote
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-paper/60">Reading the trust tiers…</p>
        )}
        <p className="mt-6 max-w-2xl leading-relaxed text-paper/60">
          A payout only ever goes to the bounty&rsquo;s claimant, for at most its reward. The agent
          can ask for nothing else, whatever a submission says.
        </p>
      </Block>

      <Block
        label="Contributors"
        intro="Every point traces to a bounty paid in full."
        className="border-t border-paper/15"
      >
        {board && board.contributors.length === 0 && (
          <p className="text-paper/60">Nobody yet. Be the first.</p>
        )}
        <ul className="flex flex-col border-t border-paper/15">
          {board?.contributors.map((c) => (
            <li
              key={c.account}
              className="grid gap-1 border-b border-paper/15 py-4 md:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)] md:gap-6"
            >
              <a
                href={account(c.account)}
                target="_blank"
                rel="noreferrer"
                className={`mono min-w-0 break-all ${ext}`}
              >
                {c.account}
              </a>
              <span className="font-bold">
                {c.points} {c.points === 1 ? "point" : "points"}
              </span>
              <span className="text-paper/60">
                Bounties {c.bounties.map((b) => `#${b}`).join(", ")}
              </span>
            </li>
          ))}
        </ul>
      </Block>

      <Block
        label="The scam list"
        intro="Every paid report. The shop checks each address it's asked about against this list."
        className="border-t border-paper/15"
      >
        {listed.length === 0 ? (
          <p className="text-paper/60">Empty so far.</p>
        ) : (
          <ChatLog count={listed.length} pin={false} className="max-h-128 pr-2">
            <ul className="flex flex-col border-t border-paper/15">
              {listed.map((e) => (
                <li
                  key={e.id}
                  className="grid gap-1 border-b border-paper/15 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_5rem] md:gap-6"
                >
                  <span className="mono min-w-0 break-all text-refused">{e.address}</span>
                  <span className="min-w-0 wrap-break-word text-paper/70">{e.evidence}</span>
                  <span className="text-dim-ink">#{e.id}</span>
                </li>
              ))}
            </ul>
          </ChatLog>
        )}
      </Block>

      <Block
        label="Who decides"
        intro="Read live from testnet."
        className="border-t border-paper/15"
      >
        {board && (
          <dl className="grid gap-8 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="label text-dim-ink">Owner: the community DAO</dt>
              <dd className="mt-2">
                <a
                  href={account(board.owner)}
                  target="_blank"
                  rel="noreferrer"
                  className={`mono break-all ${ext}`}
                >
                  {board.owner} <ArrowUpRight className="size-3.5 shrink-0" />
                </a>
                <p className="mt-2 leading-relaxed text-paper/60">
                  Votes on large payouts and on any change that loosens the rules. Loosening then
                  waits {duration(board.policy.timelock_s)} in public.
                </p>
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="label text-dim-ink">Council</dt>
              <dd className="mt-2 flex flex-col gap-1">
                {council.map((c) => (
                  <a
                    key={c}
                    href={account(c)}
                    target="_blank"
                    rel="noreferrer"
                    className={`mono break-all ${ext}`}
                  >
                    {c}
                  </a>
                ))}
                <p className="mt-2 leading-relaxed text-paper/60">
                  Approves payouts within its tier and posts bounties. Any one member can freeze the
                  purse instantly; unfreezing takes a DAO vote and the timelock.
                </p>
              </dd>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <dt className="label text-dim-ink">The purse</dt>
              <dd className="mt-2">
                <a
                  href={account(BOARD_ACCOUNT)}
                  target="_blank"
                  rel="noreferrer"
                  className={`mono break-all ${ext}`}
                >
                  {BOARD_ACCOUNT} <ArrowUpRight className="size-3.5 shrink-0" />
                </a>
                <p className="mt-2 max-w-2xl leading-relaxed text-paper/60">
                  A Pursestrings account with no full-access key: its bounty agent can only ask for
                  payouts, and the contract decides who has to approve them.
                </p>
              </dd>
            </div>
          </dl>
        )}
      </Block>
    </div>
  );
}

function BountyCard({
  id,
  bounty: b,
  request,
  review,
  proposal,
  me,
  isCouncil,
  councilSize,
  bond,
  busy,
  act,
}: {
  id: number;
  bounty: Bounty;
  request: Request | null;
  review: Review | undefined;
  proposal: Proposal | undefined;
  me: string | null;
  isCouncil: boolean;
  councilSize: number;
  bond: string | null;
  busy: string | null;
  act: (label: string, run: () => Promise<unknown>) => void;
}) {
  const [work, setWork] = useState("scam:");
  const mine = me !== null && b.claimant === me;
  const turnedDown =
    b.status === "Submitted" && review !== undefined && review.work === b.work && !review.accepted;
  const reqId = b.req_id;
  const yes = proposal ? Object.values(proposal.votes).filter((v) => v === "Approve").length : 0;
  const button =
    "border-2 border-paper px-5 py-2.5 font-extrabold uppercase tracking-[-0.01em] transition-colors hover:bg-paper hover:text-ink disabled:opacity-40";

  return (
    <li className="border border-paper/15 bg-ink p-5 md:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="label">
          <span className="text-dim-ink">#{id} · </span>
          {turnedDown ? (
            <span className="text-refused">Not accepted</span>
          ) : (
            <span className={statusTone[b.status]}>{statusText[b.status]}</span>
          )}
        </p>
        <p className="text-[1.3rem] font-bold tracking-[-0.02em]">{near(b.reward)}</p>
      </div>
      <h3 className="mt-3 wrap-break-word text-[1.1rem] font-bold leading-snug">{b.title}</h3>

      {b.claimant && (
        <p className="mt-3 text-[0.95rem] text-paper/60">
          {b.status === "Paid" ? "Paid to" : "Claimed by"}{" "}
          <span className="mono break-all text-paper/85">{b.claimant}</span>
        </p>
      )}
      {b.work && (
        <p className="mono mt-3 break-all border-l-2 border-paper/20 pl-3 text-[0.88rem] text-paper/75">
          {b.work}
        </p>
      )}

      {review && review.work === b.work && (
        <div className="mt-4 border-l-2 border-string/60 pl-4">
          <p className="label text-dim-ink">Bounty agent</p>
          <p className={`mt-2 leading-relaxed ${review.accepted ? "text-paid" : "text-refused"}`}>
            {review.accepted ? "Accepted: " : "Not accepted: "}
            {review.reasons.join(" ")}
          </p>
          {review.note && <p className="mt-1 leading-relaxed text-paper/60">{review.note}</p>}
          {turnedDown && (
            <p className="mt-2 leading-relaxed text-paper/60">
              Nothing is paid. The claimant can fix the report and submit it again for a new review,
              or give the bounty up so someone else can claim it.
            </p>
          )}
          {review.tx && (
            <a
              href={txUrl(review.tx)}
              target="_blank"
              rel="noreferrer"
              className={`mt-1 text-[0.9rem] text-dim-ink ${ext}`}
            >
              Payout request <ArrowUpRight className="size-3.5" />
            </a>
          )}
        </div>
      )}

      {b.status === "Paying" && request?.status === "PendingCouncil" && (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <p className="text-wait">Waits for one council member.</p>
          {isCouncil && reqId !== null && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                act(`approve-${id}`, () =>
                  walletCall(
                    BOARD_ACCOUNT,
                    "council_approve",
                    { req_id: reqId },
                    { tgas: 100n, deposit: "1" },
                  ),
                )
              }
              className={button}
            >
              Approve the payout
            </button>
          )}
        </div>
      )}

      {b.status === "Paying" && request?.status === "PendingCosign" && (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <p className="text-wait">
            Too large for the council: waits for a DAO vote
            {proposal ? ` (proposal #${proposal.id}, ${yes} of ${councilSize} yes)` : ""}.
          </p>
          {isCouncil && reqId !== null && !proposal && bond && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => act(`propose-${id}`, () => proposePayout(BOARD_ACCOUNT, reqId, bond))}
              className={button}
            >
              Propose it to the DAO ({near(bond)} bond)
            </button>
          )}
          {isCouncil && proposal?.status === "InProgress" && me && !proposal.votes[me] && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => act(`vote-${id}`, () => voteYes(proposal))}
              className={button}
            >
              Vote yes
            </button>
          )}
          {proposal && (
            <a
              href={account(DAO_ACCOUNT)}
              target="_blank"
              rel="noreferrer"
              className={`text-[0.9rem] text-dim-ink ${ext}`}
            >
              The DAO <ArrowUpRight className="size-3.5" />
            </a>
          )}
        </div>
      )}

      {b.status === "Open" && me && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            act(`claim-${id}`, () =>
              walletCall(BOARD_ACCOUNT, "claim_bounty", { id }, { tgas: 30n, deposit: "1" }),
            )
          }
          className={`mt-5 ${button}`}
        >
          Claim it
        </button>
      )}

      {mine && (b.status === "Claimed" || b.status === "Submitted") && (
        <div className="mt-5">
          <label htmlFor={`work-${id}`} className="label block text-dim-ink">
            Your report: scam:&lt;address&gt; then your evidence
          </label>
          <textarea
            id={`work-${id}`}
            value={work}
            onChange={(e) => setWork(e.target.value)}
            maxLength={256}
            rows={2}
            spellCheck={false}
            className="mono mt-2 w-full resize-y border border-paper/20 bg-ink-2 p-3 text-[0.92rem] text-paper focus:border-string focus:outline-none"
          />
          <button
            type="button"
            disabled={busy !== null || parseWork(work) === null}
            onClick={() =>
              act(`submit-${id}`, () =>
                walletCall(
                  BOARD_ACCOUNT,
                  "submit_bounty",
                  { id, work: work.trim() },
                  { tgas: 30n, deposit: "1" },
                ),
              )
            }
            className={`mt-3 ${button}`}
          >
            {b.status === "Submitted" ? "Submit again" : "Submit"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              act(`reopen-${id}`, () =>
                walletCall(BOARD_ACCOUNT, "reopen_bounty", { id }, { tgas: 30n, deposit: "1" }),
              )
            }
            className="mt-3 ml-4 text-[0.95rem] text-dim-ink underline underline-offset-4 hover:text-paper disabled:opacity-40"
          >
            Give it up
          </button>
        </div>
      )}
    </li>
  );
}
