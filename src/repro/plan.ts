// The reproduction plan: plain browser steps plus ONE check that describes the
// expected (correct) behaviour. If the check fails on replay, the bug is reproduced.
// Every field is required (nullable where optional) so strict JSON-schema mode accepts it.
import { z } from "zod";

/** How to find an element. Built by the snapshot code from what's really on the page, never typed by the model. */
export const TargetSchema = z.object({
  by: z.enum(["role", "label", "placeholder", "testId", "text", "css"]),
  value: z.string(),
  role: z.string().nullable(), // only for by=role
  nth: z.number().int().nullable(), // when the locator matches several elements
});
export type Target = z.infer<typeof TargetSchema>;

export type Step =
  | { do: "goto"; path: string }
  | { do: "click"; target: Target; times: number }
  | { do: "fill"; target: Target; value: string }
  | { do: "press"; target: Target; key: string }
  | { do: "select"; target: Target; value: string }
  | { do: "wait"; ms: number };

export type Check =
  | { type: "request_count"; method: string; path: string; max: number }
  | { type: "text_visible"; text: string }
  | { type: "element_text"; target: Target; expected: string }
  | { type: "no_errors" };

export interface Plan {
  viewport: { width: number; height: number };
  steps: Step[];
  check: Check;
}

export const MOBILE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 800 };

const js = (v: unknown) => JSON.stringify(v);

export function locatorCode(t: Target): string {
  const base =
    t.by === "role"
      ? `page.getByRole(${js(t.role ?? "button")}, { name: ${js(t.value)}, exact: true })`
      : t.by === "label"
        ? `page.getByLabel(${js(t.value)}, { exact: true })`
        : t.by === "placeholder"
          ? `page.getByPlaceholder(${js(t.value)}, { exact: true })`
          : t.by === "testId"
            ? `page.getByTestId(${js(t.value)})`
            : t.by === "text"
              ? `page.getByText(${js(t.value)}, { exact: true })`
              : `page.locator(${js(t.value)})`;
  return t.nth === null ? base : `${base}.nth(${t.nth})`;
}

export function describeTarget(t: Target): string {
  return t.by === "role" ? `the "${t.value}" ${t.role ?? "element"}` : t.by === "css" ? `\`${t.value}\`` : `"${t.value}"`;
}

/** Plain-English version of a step, for the issue comment. */
export function describeStep(s: Step): string {
  switch (s.do) {
    case "goto":
      return `Open \`${s.path}\``;
    case "click":
      return s.times > 1 ? `Click ${describeTarget(s.target)} ${s.times} times quickly` : `Click ${describeTarget(s.target)}`;
    case "fill":
      return `Type ${js(s.value)} into ${describeTarget(s.target)}`;
    case "press":
      return `Press ${s.key} in ${describeTarget(s.target)}`;
    case "select":
      return `Choose ${js(s.value)} in ${describeTarget(s.target)}`;
    case "wait":
      return `Wait ${s.ms} ms`;
  }
}

export function describeCheck(c: Check): string {
  switch (c.type) {
    case "request_count":
      return `\`${c.method} ${c.path}\` is sent at most ${c.max} time${c.max === 1 ? "" : "s"}`;
    case "text_visible":
      return `the page shows ${js(c.text)}`;
    case "element_text":
      return `${describeTarget(c.target)} shows ${js(c.expected)}`;
    case "no_errors":
      return "no errors, crashes or failed requests";
  }
}

/** A standalone Playwright test that fails while the bug exists and passes once it's fixed. */
export function playwrightSpec(plan: Plan, title: string, baseUrl: string): string {
  const body: string[] = [`  await page.setViewportSize(${js(plan.viewport)});`];
  if (plan.check.type === "request_count") {
    body.push(`  const sent: string[] = [];`, `  page.on("request", (r) => sent.push(\`\${r.method()} \${new URL(r.url()).pathname}\`));`);
  }
  if (plan.check.type === "no_errors") {
    body.push(`  const errors: string[] = [];`, `  page.on("pageerror", (e) => errors.push(e.message));`);
  }
  for (const s of plan.steps) {
    if (s.do === "goto") body.push(`  await page.goto(${js(new URL(s.path, baseUrl).toString())});`);
    if (s.do === "click") for (let i = 0; i < s.times; i++) body.push(`  await ${locatorCode(s.target)}.click(${s.times > 1 ? "{ noWaitAfter: true }" : ""});`);
    if (s.do === "fill") body.push(`  await ${locatorCode(s.target)}.fill(${js(s.value)});`);
    if (s.do === "press") body.push(`  await ${locatorCode(s.target)}.press(${js(s.key)});`);
    if (s.do === "select") body.push(`  await ${locatorCode(s.target)}.selectOption(${js(s.value)});`);
    if (s.do === "wait") body.push(`  await page.waitForTimeout(${s.ms});`);
    // "networkidle" only settles once per page load, so after actions give their requests time to go out.
    if (s.do === "goto") body.push(`  await page.waitForLoadState("networkidle");`);
    else if (s.do !== "wait") body.push(`  await page.waitForTimeout(500);`);
  }
  const c = plan.check;
  if (c.type === "request_count") body.push(`  await page.waitForTimeout(1000);`);
  if (c.type === "request_count") body.push(`  expect(sent.filter((r) => r === ${js(`${c.method} ${c.path}`)}).length).toBeLessThanOrEqual(${c.max});`);
  if (c.type === "text_visible") body.push(`  await expect(page.getByText(${js(c.text)}).first()).toBeVisible();`);
  if (c.type === "element_text") body.push(`  await expect(${locatorCode(c.target)}).toContainText(${js(c.expected)});`);
  if (c.type === "no_errors") body.push(`  expect(errors).toEqual([]);`);
  return `import { test, expect } from "@playwright/test";\n\ntest(${js(title)}, async ({ page }) => {\n${body.join("\n")}\n});\n`;
}
