import type { NoReproConfig, Provider } from "../config.ts";
import type { StructuredModel } from "../model.ts";
import { anthropicModel } from "./anthropic.ts";
import { openrouterModel } from "./openrouter.ts";

export const PROVIDER_KEYS: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** The model for the configured provider, failing early with a clear message if its key is missing. */
export function modelFor(config: NoReproConfig, env: Record<string, string | undefined> = process.env): StructuredModel {
  const keyName = PROVIDER_KEYS[config.provider];
  if (!env[keyName]) {
    throw new Error(`provider "${config.provider}" needs ${keyName} to be set.`);
  }
  switch (config.provider) {
    case "anthropic":
      return anthropicModel(config.model);
    case "openrouter":
      return openrouterModel(config.model);
  }
}
