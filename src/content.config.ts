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
  }),
});

const services = defineCollection({
  loader: file('src/data/services.json'),
  schema: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
  }),
});

export const collections = { site, services };
