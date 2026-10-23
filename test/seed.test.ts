import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { syncWebhookUrl } from "../src/server/seed.ts";
import { memoryStore, type AppCredentials } from "../src/server/store.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const app: AppCredentials = { id: 1, slug: "no-repro", name: "No Repro", htmlUrl: "", clientId: "", clientSecret: "", webhookSecret: "s", privateKey, webhookUrl: "https://smee.io/x" };
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

describe("moving the webhook to the host", () => {
  // The first deploy crashed here: a top-level `url` option made Octokit call that address
  // instead of /app/hook/config, and sign it as an installation.
  test("PATCHes /app/hook/config as the app, with the new address in the body", async () => {
    const calls: Array<{ url: string; method: string; auth: string; body: any }> = [];
    globalThis.fetch = (async (input: any, init: any) => {
      const req = new Request(input, init);
      calls.push({ url: req.url, method: req.method, auth: req.headers.get("authorization") ?? "", body: await req.json().catch(() => null) });
      return Response.json({ url: "https://host.example/webhook" });
    }) as typeof fetch;

    const store = memoryStore({ ...app });
    expect(await syncWebhookUrl(store, "https://host.example/webhook")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://api.github.com/app/hook/config", method: "PATCH", body: { url: "https://host.example/webhook", content_type: "json", secret: "s" } });
    expect(calls[0]!.auth).toMatch(/^bearer ey/); // a JWT for the app, not an installation token
    expect((await store.loadApp())!.webhookUrl).toBe("https://host.example/webhook");

    expect(await syncWebhookUrl(store, "https://host.example/webhook")).toBe(false); // already there: no call
    expect(calls).toHaveLength(1);
  });
});
