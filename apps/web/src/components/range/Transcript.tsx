import { reasonName, type Step } from "@/lib/range";

const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;

function decisionLine(step: Extract<Step, { kind: "tool" }>) {
  const d = step.decision;
  if (!d) return null;
  if ("Approved" in d) return <span className="text-paid">Approved: inside the policy</span>;
  if ("NeedsCosign" in d || "NeedsRisk" in d)
    return <span className="text-wait">Waiting for the owner&rsquo;s co-sign</span>;
  return <span className="text-refused">Denied: {reasonName(d.Denied.reason)}</span>;
}

export function Transcript({ prompt, steps }: { prompt: string; steps: Step[] }) {
  return (
    <ol className="mono flex flex-col gap-4 text-[0.85rem] leading-relaxed">
      <li>
        <span className="eyebrow text-dim-ink">You</span>
        <p className="mt-1 whitespace-pre-wrap text-paper">{prompt}</p>
      </li>
      {steps.map((s, i) =>
        s.kind === "agent" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a transcript is an append-only log that never reorders
          <li key={i}>
            <span className="eyebrow text-dim-ink">Agent</span>
            <p className="mt-1 whitespace-pre-wrap text-paper/70">{s.text}</p>
          </li>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a transcript is an append-only log that never reorders
          <li key={i} className="border-l-2 border-string/60 pl-4">
            <span className="eyebrow text-dim-ink">Tool · {s.name}</span>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[0.78rem] text-paper/55">
              {JSON.stringify(s.args, null, 0)}
            </pre>
            {s.decision && (
              <p className="mt-2">
                <span className="eyebrow mr-2 text-dim-ink">Contract</span>
                {decisionLine(s)}
                {s.tx && (
                  <a
                    href={explorer(s.tx)}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-3 text-dim-ink underline underline-offset-4 hover:text-paper"
                  >
                    on-chain ↗
                  </a>
                )}
              </p>
            )}
          </li>
        ),
      )}
    </ol>
  );
}
