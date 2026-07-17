/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { siteSchema, servicesSchema, portfolioSchema } from "./content-schemas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../../site/src/data");

function readJson(fileName: string): unknown {
  const filePath = path.join(dataDir, fileName);
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function report(label: string, schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) {
    console.log(`[PASS] ${label}`);
  } else {
    console.log(`[FAIL] ${label}`);
    console.log(z.prettifyError(result.error));
  }
}

const siteRaw = readJson("site.json") as { main: unknown };
report("site.json (.main against siteSchema)", siteSchema, siteRaw.main);

const servicesRaw = readJson("services.json");
report("services.json (against servicesSchema)", servicesSchema, servicesRaw);

const portfolioRaw = readJson("portfolio.json") as { main: unknown };
report("portfolio.json (.main against portfolioSchema)", portfolioSchema, portfolioRaw.main);

// Regression test for the 2026-07-17 "silent field strip" incident: an unknown
// field must be a loud validation failure (label below expects [FAIL]), never
// a silent drop back to the original content.
const siteWithUnknownField = {
  ...(siteRaw.main as Record<string, unknown>),
  secondaryEmail: "extra@example.com",
};
report(
  "site.json .main + unknown 'secondaryEmail' field — EXPECTED to FAIL (strict-mode regression test)",
  siteSchema,
  siteWithUnknownField,
);
