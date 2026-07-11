import { z } from "zod";

export const sourceSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  type: z.enum(["rss", "api", "scrape", "reader"]),
  provider: z.enum(["direct", "freshrss", "miniflux"]).optional(),
  providerSourceId: z.string().trim().min(1).optional(),
  tier: z.enum(["core", "standard", "supplement"]).optional(),
  url: z.url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "url must use http or https"),
  category: z.enum(["trending", "tech", "finance", "politics"]),
  subcategory: z.string().trim().min(1).optional(),
  useCurl: z.boolean().optional(),
  enabled: z.boolean().optional(),
  lang: z.enum(["zh", "en"]).optional(),
  locales: z.array(z.enum(["zh", "en"])).min(1).optional(),
  notes: z.string().optional(),
  keywords: z.array(z.string().trim().min(1)).optional(),
  priority: z.number().int().min(1).max(5).optional(),
});

export const sourceRegistrySchema = z.array(sourceSchema).superRefine((sources, ctx) => {
  const seen = new Set<string>();
  for (const [index, source] of sources.entries()) {
    if (seen.has(source.id)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate id '${source.id}'`,
        path: [index, "id"],
      });
    }
    seen.add(source.id);
    if (source.type === "reader" && !["freshrss", "miniflux"].includes(source.provider ?? "")) {
      ctx.addIssue({
        code: "custom",
        message: "reader sources require provider freshrss or miniflux",
        path: [index, "provider"],
      });
    }
    if (source.type !== "reader" && source.provider && source.provider !== "direct") {
      ctx.addIssue({
        code: "custom",
        message: "only reader sources may use a reader provider",
        path: [index, "provider"],
      });
    }
  }
});
