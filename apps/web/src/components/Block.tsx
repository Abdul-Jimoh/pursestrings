/** A page section: a label and one-line intro on the left, the content on the right. */
export function Block({
  id,
  label,
  intro,
  children,
  className = "",
}: {
  id?: string;
  label: string;
  intro?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`range-block grid gap-8 px-5 py-20 md:px-10 md:py-28 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:gap-16 ${className}`}
    >
      <div>
        <h2 className="eyebrow text-dim-ink">{label}</h2>
        {intro && <p className="mt-4 max-w-sm leading-relaxed text-paper/60">{intro}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
