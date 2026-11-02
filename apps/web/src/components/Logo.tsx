/**
 * The mark: a sack cinched shut by its drawstring, with the loose end ending in a pull ring.
 * The purse is the agent's; the ring is the owner's.
 */
export function Mark({
  className = "",
  title = "Pursestrings",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label={title} fill="none">
      <g stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M26.5 26C14 31 10.5 43 13 50c2.4 6 9.5 8 19 8s16.6-2 19-8c2.5-7-1-19-13.5-24" />
        <path d="M26.5 26 22 12.5c3.4 2.2 6.6 2.2 10 0 3.4 2.2 6.6 2.2 10 0L37.5 26" />
      </g>
      <path
        d="M22 26.5h20c4.5 0 7.5 3.5 7.5 9.5"
        stroke="var(--color-string)"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="49.5" cy="41" r="3.6" stroke="var(--color-string)" strokeWidth="3" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <Mark className="h-8 w-8" />
      <span className="text-[1.05rem] font-extrabold uppercase tracking-[-0.03em] [font-variation-settings:'wdth'_112]">
        Pursestrings
      </span>
    </span>
  );
}
