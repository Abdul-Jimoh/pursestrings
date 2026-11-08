/** A page section: a heading and one-line intro on the left, the content on the right. */
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
      className={`range-block grid gap-10 px-5 py-20 md:px-10 md:py-28 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-16 ${className}`}
    >
      <div>
        <span aria-hidden="true" className="block h-0.5 w-8 bg-string" />
        <h2 className="heading-section mt-5">{label}</h2>
        {intro && <p className="mt-4 max-w-sm leading-relaxed text-paper/65">{intro}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
