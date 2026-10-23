// Package this machine's GitHub App, Sentry installs and projects for a host, as NOREPRO_SEED.
// Writes to a file (never the terminal): it holds the app's private key.
//   bun scripts/export-seed.ts .norepro/seed.txt
import { fileStore } from "../src/server/store.ts";
import { encodeSeed, exportSeed } from "../src/server/seed.ts";

const out = process.argv[2];
if (!out) {
  console.error("Usage: bun scripts/export-seed.ts <output file>");
  process.exit(1);
}
const seed = await exportSeed(fileStore(process.env.NOREPRO_DATA_DIR ?? ".norepro"));
await Bun.write(out, encodeSeed(seed));
console.log(`Wrote ${out}: GitHub App "${seed.app.name}", ${seed.sentry.length} Sentry org(s), ${seed.projects.length} project(s).`);
