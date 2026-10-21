import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { readFileSync } from "node:fs";
import { parseConfig } from "../src/core/config.ts";
import { reportExtractor } from "../src/core/clarity.ts";
import { modelFor } from "../src/core/providers/index.ts";
import { openrouterModel } from "../src/core/providers/openrouter.ts";
import type { BugReport } from "../src/core/report.ts";

const thread = { title: "Search broken", body: "searched 'shoes ' and got nothing", replies: [] };
const config = parseConfig("app:\n  name: ShopLite\nprovider: openrouter\n");
const openrouterExtractor = (client: OpenAI) => reportExtractor(openrouterModel(config.model, client));

const report: BugReport = {
  title: "Trailing space in search returns no results",
  page: "/",
  steps: ["Type 'shoes ' in search", "Press Search"],
  expected: "Running Shoes is listed",
  actual: "0 results",
  environment: { device: "unknown", browser: null },
  testValues: ["shoes "],
  lastWorkingVersion: null,
  checkable: true,
  notCheckableReason: null,
  question: null,
};

/** Minimal stand-in for the OpenAI client: records the request, returns a canned choice. */
function fakeClient(choice: { content: string | null; finish_reason?: string; refusal?: string | null }) {
  const calls: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (params: unknown) => {
          calls.push(params);
          return {
            choices: [{ finish_reason: choice.finish_reason ?? "stop", message: { content: choice.content, refusal: choice.refusal ?? null } }],
          };
        },
      },
    },
  };
  return { client: client as unknown as OpenAI, calls };
}

describe("provider config", () => {
  test("model defaults follow the provider", () => {
    expect(parseConfig("app:\n  name: X\n").model).toBe("claude-opus-5-5");
    expect(config.model).toBe("anthropic/claude-opus-5.5");
    expect(parseConfig("app:\n  name: X\nprovider: openrouter\nmodel: openai/gpt-5.6-sol\n").model).toBe("openai/gpt-5.6-sol");
  });

  test("this repo runs on OpenRouter", () => {
    expect(parseConfig(readFileSync(".github/norepro.yml", "utf8")).provider).toBe("openrouter");
  });

  test("unknown provider is rejected", () => {
    expect(() => parseConfig("app:\n  name: X\nprovider: gemini\n")).toThrow(/provider/);
  });

  test("missing key fails early and names the variable", () => {
    expect(() => modelFor(config, {})).toThrow(/OPENROUTER_API_KEY/);
    expect(() => modelFor(parseConfig("app:\n  name: X\n"), {})).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("openrouter extractor", () => {
  test("sends a strict JSON schema and returns the validated report", async () => {
    const { client, calls } = fakeClient({ content: JSON.stringify(report) });
    const out = await openrouterExtractor(client)(thread, config);
    expect(out.testValues).toEqual(["shoes "]);

    const req = calls[0];
    expect(req.model).toBe("anthropic/claude-opus-5.5");
    expect(req.provider).toEqual({ require_parameters: true });
    expect(req.response_format.json_schema.strict).toBe(true);
    expect(req.response_format.json_schema.name).toBe("bug_report");
    expect(req.response_format.json_schema.schema.$schema).toBeUndefined();
    expect(req.response_format.json_schema.schema.required).toContain("checkable");
    expect(req.messages[1].content).toContain("<issue>");
  });

  test("rejects output that doesn't match the schema", async () => {
    const { client } = fakeClient({ content: JSON.stringify({ ...report, checkable: "yes" }) });
    await expect(openrouterExtractor(client)(thread, config)).rejects.toThrow(/schema/);
  });

  test("rejects non-JSON, truncation and refusals", async () => {
    await expect(openrouterExtractor(fakeClient({ content: "sure! here you go" }).client)(thread, config)).rejects.toThrow(/valid JSON/);
    await expect(openrouterExtractor(fakeClient({ content: "{", finish_reason: "length" }).client)(thread, config)).rejects.toThrow(/cut off/);
    await expect(openrouterExtractor(fakeClient({ content: null, refusal: "no" }).client)(thread, config)).rejects.toThrow(/declined/);
  });
});
