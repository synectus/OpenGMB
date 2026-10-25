// apps/web/app/l/[slug]/page.tsx
import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { localBusinessJsonLd, locationPageData, safeJsonLd } from "@opengmb/core";
import { ShareFrame } from "../../../components/share/share-frame";
import { getDb } from "../../../lib/auth";

// Public, no login. Unpublished, unknown and inactive all look the same: 404 (Next marks it noindex).
export const dynamic = "force-dynamic";
const load = cache((slug: string) => locationPageData(getDb(), slug));
const origin = () => (process.env.BETTER_AUTH_URL || "http://localhost:3000").replace(/\/$/, "");

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await load(slug);
  if (!page) return { title: "Not found", robots: { index: false, follow: false } };
  const d = page.data;
  const kind = d.categories[0] ?? "Local business";
  const description = (d.description ?? `${d.name}, ${kind.toLowerCase()}${d.address ? ` at ${d.address}` : ""}. Opening hours, location and contact details.`).replace(/\s+/g, " ").slice(0, 155);
  return {
    title: `${d.name} | ${kind}`,
    description,
    alternates: { canonical: `${origin()}/l/${d.slug}` },
    robots: { index: true, follow: true },
    openGraph: { title: d.name, description, url: `${origin()}/l/${d.slug}`, type: "website" },
  };
}

const h2 = "font-display text-lg font-bold";
const card = "rounded-xl border border-border p-4";

export default async function LocationLandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await load(slug);
  if (!page) notFound();
  const d = page.data;
  const ld = localBusinessJsonLd(d, `${origin()}/l/${d.slug}`, page.regularHours);
  return (
    <ShareFrame
      brand={{ agencyName: d.brand.agencyName, colour: d.brand.primaryColor, logoUrl: d.brand.logoUrl }}
      footer={<span className="text-xs text-muted-foreground">Page by {d.brand.agencyName}. Information from the business&apos;s Google Business Profile.</span>}
    >
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(ld) }} />
      <section aria-label="Business" className="flex flex-col gap-3">
        {d.categories.length > 0 && <p className="text-sm font-semibold text-muted-foreground">{d.categories.join(" · ")}</p>}
        <h1 className="font-display text-[28px] leading-[34px] font-extrabold">{d.name}</h1>
        {d.rating !== null && d.reviewCount > 0 && (
          <p className="text-sm">
            <strong className="tabular-nums">{d.rating.toFixed(1)}</strong> out of 5 from {d.reviewCount} Google {d.reviewCount === 1 ? "rating" : "ratings"}
          </p>
        )}
        {d.description && <p className="max-w-[68ch] whitespace-pre-line text-base leading-6">{d.description}</p>}
      </section>

      <section aria-label="Contact" className="grid gap-3 sm:grid-cols-2">
        <div className={`${card} flex flex-col gap-2`}>
          <h2 className={h2}>Find us</h2>
          {d.address && <p className="text-sm">{d.address}</p>}
          <a href={d.mapUrl} target="_blank" rel="noreferrer noopener" className="text-sm font-semibold text-brand-text underline underline-offset-2">Open in Google Maps</a>
          {d.phone && (
            <p className="text-sm">
              Phone: <a href={`tel:${d.phone.replace(/[^+\d]/g, "")}`} className="font-semibold text-brand-text underline underline-offset-2">{d.phone}</a>
            </p>
          )}
          {d.website && (
            <p className="text-sm break-words">
              Website: <a href={d.website} target="_blank" rel="noreferrer noopener" className="font-semibold text-brand-text underline underline-offset-2">{d.website.replace(/^https:\/\//, "").replace(/\/$/, "")}</a>
            </p>
          )}
        </div>
        {d.hours.length > 0 && (
          <div className={card}>
            <h2 className={`${h2} mb-2`}>Opening hours</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {d.hours.map((h) => (
                <div key={h.day} className="contents">
                  <dt className="font-medium">{h.day}</dt>
                  <dd className="text-muted-foreground">{h.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </section>

      {d.services.length > 0 && (
        <section aria-label="Services">
          <h2 className={`${h2} mb-3`}>Services</h2>
          <ul className="flex flex-wrap gap-2">
            {d.services.map((s) => (
              <li key={s} className="rounded-full border border-border px-3 py-1 text-sm">{s}</li>
            ))}
          </ul>
        </section>
      )}

      {d.photos.length > 0 && (
        <section aria-label="Photos">
          <h2 className={`${h2} mb-3`}>Photos</h2>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {d.photos.map((p, i) => (
              <li key={i}>
                {/* eslint-disable-next-line @next/next/no-img-element -- Google-hosted, not stable */}
                <img src={p.url} alt={p.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="aspect-square w-full rounded-control object-cover" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.reviews.length > 0 && (
        <section aria-label="Reviews">
          <h2 className={`${h2} mb-1`}>What people say</h2>
          {d.reviewNote && <p className="mb-3 text-sm text-muted-foreground">{d.reviewNote}</p>}
          <ul className="grid gap-3 sm:grid-cols-2">
            {d.reviews.map((r, i) => (
              <li key={i} className={`${card} flex flex-col gap-1.5`}>
                <span className="text-sm font-semibold">{r.rating} out of 5 stars</span>
                <p className="text-sm leading-5">{r.text}</p>
                <span className="text-xs text-muted-foreground">{r.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.posts.length > 0 && (
        <section aria-label="Latest news">
          <h2 className={`${h2} mb-3`}>Latest news</h2>
          <ul className="grid gap-3 sm:grid-cols-3">
            {d.posts.map((p, i) => (
              <li key={i} className={`${card} flex flex-col gap-2`}>
                {p.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element -- Google-hosted, not stable
                  <img src={p.imageUrl} alt="" referrerPolicy="no-referrer" className="aspect-video w-full rounded-control object-cover" />
                )}
                <p className="text-sm leading-5">{p.summary}</p>
                {p.linkUrl && <a href={p.linkUrl} target="_blank" rel="noreferrer noopener" className="text-sm font-semibold text-brand-text underline underline-offset-2">Read more</a>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </ShareFrame>
  );
}
