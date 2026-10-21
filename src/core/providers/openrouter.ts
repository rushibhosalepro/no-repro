import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { z } from "zod";
import type { StructuredModel } from "../model.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Strict JSON-schema mode wants a plain schema object; zod's draft marker isn't part of that. */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _draft, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/** Any model on OpenRouter through the OpenAI SDK (OPENROUTER_API_KEY). */
export function openrouterClient(apiKey = process.env.OPENROUTER_API_KEY): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: { "X-Title": "No Repro" },
  });
}

export function openrouterModel(modelId: string, client: OpenAI = openrouterClient()): StructuredModel {
  return {
    async generate({ name, system, user, schema }) {
      // `provider.require_parameters` is an OpenRouter extension: only route to upstream
      // providers that honour structured outputs, rather than silently dropping the schema.
      const params: ChatCompletionCreateParamsNonStreaming & { provider: { require_parameters: boolean } } = {
        model: modelId,
        max_tokens: 16000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name, strict: true, schema: strictJsonSchema(schema) },
        },
        provider: { require_parameters: true },
      };
      const completion = await client.chat.completions.create(params);

      const choice = completion.choices[0];
      if (!choice) throw new Error("Model returned no choices.");
      if (choice.message.refusal) throw new Error(`Model declined the request: ${choice.message.refusal}`);
      if (choice.finish_reason === "length") throw new Error("Model output was cut off before it was complete.");

      const content = choice.message.content;
      if (!content) throw new Error("Model returned an empty response.");
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch {
        throw new Error("Model returned text that isn't valid JSON.");
      }
      // Validate even in strict mode: not every upstream provider enforces the schema exactly.
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new Error(`Model output didn't match the expected schema: ${parsed.error.issues[0]?.message ?? "unknown"}`);
      }
      return parsed.data;
    },
  };
}
