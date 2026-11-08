export type Stat = { label: string; value: string; dot?: string; tone?: string; note?: string };

export function Stats({ stats, className = "" }: { stats: Stat[]; className?: string }) {
  return (
    <dl
      className={`grid grid-cols-1 gap-px border border-paper/15 bg-paper/15 sm:grid-cols-2 lg:grid-cols-4 ${className}`}
    >
      {stats.map((s) => (
        <div key={s.label} className="bg-ink p-6 md:p-8">
          <dt className="label text-dim-ink">{s.label}</dt>
          <dd
            className={`mt-3 flex items-center gap-3 text-[1.6rem] font-bold leading-tight tracking-[-0.02em] ${s.tone ?? ""}`}
          >
            {s.dot && <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${s.dot}`} />}
            {s.value}
          </dd>
          {s.note && <dd className="mt-1 text-[0.9rem] text-paper/50">{s.note}</dd>}
        </div>
      ))}
    </dl>
  );
}
