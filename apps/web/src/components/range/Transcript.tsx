import { ArrowUpRight } from "lucide-react";
import { reasonName, type Step } from "@/lib/range";
import { Bubble, ChatLog } from "../ChatLog";

const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;

type Tone = "paid" | "wait" | "refused";

function decisionLine(step: Extract<Step, { kind: "tool" }>): { tone: Tone; text: string } | null {
  const d = step.decision;
  if (!d) return null;
  if ("Approved" in d) return { tone: "paid", text: "Approved: inside the policy" };
  if ("NeedsCosign" in d || "NeedsRisk" in d)
    return { tone: "wait", text: "Held: waits for the owner’s co-sign" };
  return { tone: "refused", text: `Refused: ${reasonName(d.Denied.reason)}` };
}

const border: Record<Tone, string> = {
  paid: "border-paid",
  wait: "border-wait",
  refused: "border-refused",
};
const text: Record<Tone, string> = {
  paid: "text-paid",
  wait: "text-wait",
  refused: "text-refused",
};

export function Transcript({ prompt, steps }: { prompt: string; steps: Step[] }) {
  return (
    <ChatLog count={steps.length} className="max-h-[min(70vh,36rem)] pr-2">
      <ol className="flex flex-col gap-5">
        <Bubble who="you">{prompt}</Bubble>
        {steps.map((s, i) => {
          if (s.kind === "agent")
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: a transcript is an append-only log that never reorders
              <Bubble key={i} who="agent">
                {s.text}
              </Bubble>
            );
          const d = decisionLine(s);
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a transcript is an append-only log that never reorders
              key={i}
              className={`border-l-2 py-1 pl-4 ${d ? border[d.tone] : "border-paper/20"}`}
            >
              <p className="label text-dim-ink">
                {d ? "The contract on NEAR" : "The agent checks"} · {s.name}
              </p>
              {d && <p className={`mt-1 font-semibold ${text[d.tone]}`}>{d.text}</p>}
              {s.tx && (
                <a
                  href={explorer(s.tx)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-[0.88rem] text-dim-ink underline underline-offset-4 hover:text-paper"
                >
                  See the transaction <ArrowUpRight className="size-3.5" />
                </a>
              )}
              <details className="mt-1">
                <summary className="cursor-pointer text-[0.88rem] text-dim-ink hover:text-paper">
                  What the agent sent
                </summary>
                <pre className="mono mt-2 whitespace-pre-wrap break-all text-[0.78rem] leading-relaxed text-paper/55">
                  {JSON.stringify(s.args, null, 2)}
                </pre>
              </details>
            </li>
          );
        })}
      </ol>
    </ChatLog>
  );
}
