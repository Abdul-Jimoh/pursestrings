import { reasonName, type Step } from "@/lib/range";

const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;

function decisionLine(step: Extract<Step, { kind: "tool" }>) {
  const d = step.decision;
  if (!d) return null;
  if ("Approved" in d) return <span className="text-paid">Approved: inside the policy</span>;
  if ("NeedsCosign" in d || "NeedsRisk" in d)
    return <span className="text-wait">Held: waits for the owner&rsquo;s co-sign</span>;
  return <span className="text-refused">Refused: {reasonName(d.Denied.reason)}</span>;
}

export function Transcript({ prompt, steps }: { prompt: string; steps: Step[] }) {
  return (
    <ol className="flex flex-col gap-6">
      <li>
        <p className="eyebrow text-dim-ink">You</p>
        <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed text-paper">{prompt}</p>
      </li>
      {steps.map((s, i) =>
        s.kind === "agent" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a transcript is an append-only log that never reorders
          <li key={i}>
            <p className="eyebrow text-dim-ink">Agent</p>
            <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed text-paper/70">
              {s.text}
            </p>
          </li>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a transcript is an append-only log that never reorders
          <li key={i} className="border-l-2 border-string/60 pl-4">
            <p className="eyebrow text-dim-ink">
              {s.decision ? "Contract on NEAR" : "Agent checks"} · {s.name}
            </p>
            {s.decision && <p className="mt-2 leading-relaxed">{decisionLine(s)}</p>}
            {s.tx && (
              <a
                href={explorer(s.tx)}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-[0.9rem] text-dim-ink underline underline-offset-4 hover:text-paper"
              >
                See the transaction ↗
              </a>
            )}
            <details className="mt-2">
              <summary className="eyebrow cursor-pointer text-dim-ink hover:text-paper">
                What the agent sent
              </summary>
              <pre className="mono mt-2 whitespace-pre-wrap break-all text-[0.78rem] leading-relaxed text-paper/55">
                {JSON.stringify(s.args, null, 2)}
              </pre>
            </details>
          </li>
        ),
      )}
    </ol>
  );
}
