import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { StructuredModel } from "../model.ts";

/** Claude through the Anthropic API directly (ANTHROPIC_API_KEY). */
export function anthropicModel(modelId: string, client: Anthropic = new Anthropic()): StructuredModel {
  return {
    async generate({ system, user, schema }) {
      const response = await client.beta.messages.parse({
        model: modelId,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
        system,
        messages: [{ role: "user", content: user }],
      });

      if (response.stop_reason === "refusal") {
        throw new Error(`Model declined the request (${response.stop_details?.category ?? "no category"}).`);
      }
      if (response.stop_reason === "max_tokens") {
        throw new Error("Model output was cut off before it was complete.");
      }
      if (response.parsed_output == null) {
        throw new Error("Model returned no parseable output.");
      }
      return response.parsed_output;
    },
  };
}
