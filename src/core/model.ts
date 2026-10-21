import type { z } from "zod";

export interface StructuredRequest<T extends z.ZodType> {
  /** Short identifier for the output, e.g. "bug_report". Used as the JSON-schema name. */
  name: string;
  system: string;
  user: string;
  schema: T;
}

/** One model call that must come back as data matching `schema`. Each provider implements this. */
export interface StructuredModel {
  generate<T extends z.ZodType>(request: StructuredRequest<T>): Promise<z.infer<T>>;
}
