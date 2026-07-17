import { z } from "zod";

/**
 * WARNING: this file duplicates the Zod schemas defined in site/src/content.config.ts.
 * The bot and the site are separate npm packages, so this duplication is intentional —
 * but it means if you change a schema in site/src/content.config.ts, you MUST update
 * the matching schema here too, or the bot will validate against a stale shape.
 */

/**
 * Wrapper quirk: on disk, site/src/data/site.json and site/src/data/portfolio.json
 * are each a single object keyed "main" — i.e. `{ "main": { ...fields } }` — because
 * Astro reads them via `getEntry(collection, "main")`. siteSchema and portfolioSchema
 * below validate the INNER object only (the value of `.main`), since that's the part
 * the bot actually reads and rewrites. Callers must unwrap `.main` before validating
 * and re-wrap the result as `{ main: ... }` before writing the file back to disk.
 *
 * site/src/data/services.json has no such wrapper — it's a flat array on disk, read
 * via `getCollection('services')` — so servicesSchema validates that array directly.
 */

export const siteSchema = z.object({
  name: z.string(),
  heroEyebrow: z.string(),
  heroHeadline: z.string(),
  heroSubhead: z.string(),
  aboutHeading: z.string(),
  aboutBody: z.array(z.string()),
  aboutPhotoAlt: z.string(),
  contactHeading: z.string(),
  contactBody: z.string(),
  email: z.string().email(),
  instagramUrl: z.string().url().optional(),
  telegramUrl: z.string().url().optional(),
});

export const servicesSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
  }),
);

export const portfolioSchema = z.object({
  eyebrow: z.string(),
  heading: z.string(),
  subhead: z.string(),
  experienceHeading: z.string(),
  experience: z.array(
    z.object({
      role: z.string(),
      company: z.string(),
      period: z.string(),
      bullets: z.array(z.string()),
    }),
  ),
  projectsHeading: z.string(),
  projectsSubhead: z.string(),
  projects: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      url: z.string().url(),
    }),
  ),
  educationHeading: z.string(),
  educationBody: z.array(z.string()),
  ctaHeading: z.string(),
  ctaBody: z.string(),
  ctaEmail: z.string().email(),
  githubUrl: z.string().url(),
});

export type SiteContent = z.infer<typeof siteSchema>;
export type ServicesContent = z.infer<typeof servicesSchema>;
export type PortfolioContent = z.infer<typeof portfolioSchema>;

export const CONTENT_FILES = {
  site: { path: "site/src/data/site.json", schema: siteSchema },
  services: { path: "site/src/data/services.json", schema: servicesSchema },
  portfolio: { path: "site/src/data/portfolio.json", schema: portfolioSchema },
} as const;
