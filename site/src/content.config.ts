import { defineCollection } from 'astro:content';
import { file } from 'astro/loaders';
import { z } from 'astro/zod';

const site = defineCollection({
  loader: file('src/data/site.json'),
  schema: z.object({
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
  }).strict(),
});

const services = defineCollection({
  loader: file('src/data/services.json'),
  schema: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
  }).strict(),
});

const portfolio = defineCollection({
  loader: file('src/data/portfolio.json'),
  schema: z.object({
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
      }).strict(),
    ),
    projectsHeading: z.string(),
    projectsSubhead: z.string(),
    projects: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        url: z.string().url(),
      }).strict(),
    ),
    educationHeading: z.string(),
    educationBody: z.array(z.string()),
    ctaHeading: z.string(),
    ctaBody: z.string(),
    ctaEmail: z.string().email(),
    githubUrl: z.string().url(),
  }).strict(),
});

export const collections = { site, services, portfolio };
