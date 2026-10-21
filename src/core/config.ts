import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// `.github/norepro.yml` in the repo being watched. Everything except `app.name`
// has a default so a minimal config is a few lines.
const PageSchema = z.object({
  path: z.string().startsWith("/"),
  description: z.string().default(""),
});

export const ConfigSchema = z.object({
  app: z.object({
    name: z.string(),
    description: z.string().default(""),
    // Either boot the app inside CI (`start`) or point at a deployed one (`baseUrl` only).
    start: z.string().optional(),
    baseUrl: z.string().url().default("http://localhost:3000"),
    ready: z.string().startsWith("/").default("/"),
    // e.g. "POST /__reset" — called before every replay run so each run starts clean.
    reset: z
      .string()
      .regex(/^(GET|POST|PUT|DELETE) \//, "reset must look like 'POST /path'")
      .optional(),
    pages: z.array(PageSchema).default([]),
  }),
  replay: z
    .object({
      runs: z.number().int().min(1).max(10).default(3),
      timeoutSeconds: z.number().int().min(10).max(600).default(90),
    })
    .default({ runs: 3, timeoutSeconds: 90 }),
  // anthropic: Claude via ANTHROPIC_API_KEY. openrouter: any OpenRouter model via OPENROUTER_API_KEY (OpenAI SDK).
  provider: z.enum(["anthropic", "openrouter"]).default("anthropic"),
  // Defaults per provider, see DEFAULT_MODELS. Model ids differ: "claude-opus-5-5" vs "anthropic/claude-opus-5.5".
  model: z.string().optional(),
  limits: z
    .object({
      // Hard cap on agent runs per issue, so a public repo can't be used to burn API credits.
      maxRunsPerIssue: z.number().int().min(1).default(5),
    })
    .default({ maxRunsPerIssue: 5 }),
  // Used to generate the optional GitHub Actions workflow that replays bugs on the repo's own runner.
  run: z
    .object({
      install: z.string().default("npm ci"),
      // Names of repo secrets the app needs to start, e.g. [GEMINI_API_KEY]. Values never leave GitHub.
      env: z.array(z.string()).default([]),
    })
    .default({ install: "npm ci", env: [] }),
  // For clear reports, read the repo source to point at the likely faulty lines and the commit behind them.
  localize: z.boolean().default(true),
  // Only triage issues carrying one of these labels. Empty = triage every new issue.
  onlyLabels: z.array(z.string()).default([]),
});

export type Provider = z.infer<typeof ConfigSchema>["provider"];
export type NoReproConfig = z.infer<typeof ConfigSchema> & { model: string };

export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-opus-5-5",
  openrouter: "anthropic/claude-opus-5.5",
};

export const DEFAULT_CONFIG_PATH = ".github/norepro.yml";

export function parseConfig(yamlText: string): NoReproConfig {
  const raw = parseYaml(yamlText) ?? {};
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid norepro config:\n${problems}`);
  }
  return { ...result.data, model: result.data.model ?? DEFAULT_MODELS[result.data.provider] };
}

export async function loadConfig(path: string): Promise<NoReproConfig> {
  return parseConfig(await readFile(path, "utf8"));
}

/** The only origin the browser may talk to. Everything else gets blocked during replay. */
export function allowedOrigin(config: NoReproConfig): string {
  return new URL(config.app.baseUrl).origin;
}
