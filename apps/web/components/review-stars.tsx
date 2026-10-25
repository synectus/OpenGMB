/** Star rating with the accessible name the e2e smoke test (and screen readers) read: "N out of 5 stars". */
export function ReviewStars({ rating, className = "" }: { rating: number | null; className?: string }) {
  if (rating === null) return <span className="text-sm text-muted-foreground">No rating</span>;
  return (
    <span
      role="img"
      aria-label={`${rating} out of 5 stars`}
      className={`tracking-wide ${rating <= 2 ? "text-bad" : "text-brand"} ${className}`}
    >
      {"★".repeat(rating)}
      <span className="text-border">{"★".repeat(5 - rating)}</span>
    </span>
  );
}
