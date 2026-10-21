// Read-only view of a repo's source at one commit. GitHub (server) and a local
// git checkout (CLI) both implement it, so the locating logic never knows which.

export interface SourceFile {
  path: string;
  size: number;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string; // ISO
  url: string | null;
  /** True when this commit created the file, i.e. the lines have been there since the file was added. */
  addedFile: boolean;
}

export interface CodeHost {
  /** Commit everything is read at (default branch head). */
  headSha(): Promise<string>;
  listFiles(sha: string): Promise<SourceFile[]>;
  readFile(path: string, sha: string): Promise<string>;
  /** The most recent commit that changed any of lines start..end (1-based, inclusive). */
  lastChange(path: string, start: number, end: number, sha: string): Promise<CommitInfo | null>;
  /** Link to the lines at that commit, if the host has a web UI. */
  permalink(path: string, start: number, end: number, sha: string): string | null;
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|php|cs|rs|swift|vue|svelte|html|css|scss|sql)$/i;
const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|vendor|coverage|\.git|__pycache__|\.venv|target)\//;
const SKIP_FILE = /(\.min\.(js|css)$)|(\.d\.ts$)|(\.(test|spec)\.[jt]sx?$)|((^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$)/i;
const MAX_FILE_BYTES = 200_000;

/** Files worth reading for a bug: app source, not dependencies, builds, lockfiles or tests. */
export function isSourceFile(f: SourceFile): boolean {
  return SOURCE_EXT.test(f.path) && !SKIP_DIR.test(f.path) && !SKIP_FILE.test(f.path) && f.size <= MAX_FILE_BYTES;
}

/** Prefix each line with its number so the model can cite exact lines. */
export function numbered(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width)} | ${l}`).join("\n");
}

export function lineCount(content: string): number {
  return content.replace(/\r\n/g, "\n").split("\n").length;
}

/** GitHub line anchor: #L5 for one line, #L5-L9 for a range. */
export function lineAnchor(start: number, end: number): string {
  return start === end ? `#L${start}` : `#L${start}-L${end}`;
}
