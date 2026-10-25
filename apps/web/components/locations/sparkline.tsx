/** A tiny decorative trend line. The card around it carries the numbers as text. */
export function Sparkline({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${(2 + (i * 116) / (values.length - 1)).toFixed(1)},${(36 - ((v - min) / span) * 32).toFixed(1)}`)
    .join(" ");
  return (
    <svg aria-hidden viewBox="0 0 120 40" className={`h-10 w-full ${up ? "text-good" : "text-bad"}`}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}
