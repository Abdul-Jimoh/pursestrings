"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { type Entry, range } from "@/lib/range";
import { AttemptList } from "./Attempts";

const PAGE = 25;

export function AllAttempts() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const more = useCallback(async (before?: number) => {
    setLoading(true);
    try {
      const page = await range.log(PAGE, before);
      setEntries((old) => (before === undefined ? page.entries : [...old, ...page.entries]));
      setTotal(page.total);
      setError(null);
    } catch {
      setError("The Range is offline right now.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    more();
  }, [more]);

  const oldest = entries.at(-1)?.id;
  return (
    <div className="surface-ink grain relative px-5 pb-24 pt-32 md:px-10 md:pb-32 md:pt-44">
      <Link
        href="/range"
        className="eyebrow inline-flex items-center gap-2 text-dim-ink hover:text-paper"
      >
        <ArrowLeft className="size-4" /> The Range
      </Link>
      <h1 className="display mt-8 text-[clamp(2.4rem,9vw,4rem)] md:text-[clamp(4rem,6.5vw,7rem)]">
        Every <span className="text-string">attempt.</span>
      </h1>
      <p className="mt-6 max-w-2xl text-[1.1rem] leading-relaxed text-paper/70">
        {total === null
          ? "Loading…"
          : `${total} ${total === 1 ? "attempt" : "attempts"} so far, newest first. Open one to see what the agent did and what the contract decided.`}
      </p>
      <div className="mt-12 max-w-5xl">
        {error && <p className="text-refused">{error}</p>}
        <AttemptList entries={entries} />
        {total !== null && entries.length < total && oldest !== undefined && (
          <button
            type="button"
            disabled={loading}
            onClick={() => more(oldest)}
            className="label mt-8 border border-paper/40 px-5 py-3 transition-colors hover:bg-paper hover:text-ink disabled:opacity-40"
          >
            {loading ? "Loading…" : "Show older"}
          </button>
        )}
      </div>
    </div>
  );
}
