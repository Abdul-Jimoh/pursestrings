export function Chapter({ n, label, dark = false }: { n: string; label: string; dark?: boolean }) {
  return (
    <p className={`eyebrow flex items-center gap-3 ${dark ? "text-dim-ink" : "text-dim"}`}>
      <span className="inline-flex h-6 min-w-6 items-center justify-center bg-string px-1.5 text-ink">
        {n}
      </span>
      {label}
    </p>
  );
}
