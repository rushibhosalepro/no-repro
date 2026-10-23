// Sentry as an evidence source: what actually happened in production.
// Connected through a Sentry "public integration" (install button, no tokens to paste):
//   install → Sentry redirects to /sentry/callback?code&installationId → exchange for a token
//   (8h lifetime, refreshed with the client secret) → read issues and their latest event.
// Docs: docs.sentry.io/organization/integrations/integration-platform/public-integration/

export const SENTRY_API = "https://sentry.io/api/0";

export interface SentryAppConfig {
  clientId: string;
  clientSecret: string;
  slug: string;
}

export function sentryAppFromEnv(env: Record<string, string | undefined>): SentryAppConfig | null {
  const { SENTRY_CLIENT_ID: clientId, SENTRY_CLIENT_SECRET: clientSecret, SENTRY_INTEGRATION_SLUG: slug } = env;
  return clientId && clientSecret && slug ? { clientId, clientSecret, slug } : null;
}

export function sentryInstallUrl(app: SentryAppConfig): string {
  return `https://sentry.io/sentry-apps/${encodeURIComponent(app.slug)}/external-install/`;
}

/** One organization's installation of our integration. */
export interface SentryInstallation {
  installationId: string;
  org: string;
  token: string;
  refreshToken: string;
  expiresAt: string;
}

type Fetch = typeof fetch;

async function authorize(app: SentryAppConfig, installationId: string, body: Record<string, string>, fetchImpl: Fetch) {
  const res = await fetchImpl(`${SENTRY_API}/sentry-app-installations/${encodeURIComponent(installationId)}/authorizations/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, client_id: app.clientId, client_secret: app.clientSecret }),
  });
  if (!res.ok) throw new Error(`Sentry refused the authorization (HTTP ${res.status}).`);
  const data = (await res.json()) as { token: string; refreshToken: string; expiresAt: string };
  return { token: data.token, refreshToken: data.refreshToken, expiresAt: data.expiresAt };
}

/** After the owner clicks Install: trade the one-time code for a token, confirm the install, find the org. */
export async function completeInstall(
  app: SentryAppConfig,
  installationId: string,
  code: string,
  orgFromQuery: string | null,
  fetchImpl: Fetch = fetch,
): Promise<SentryInstallation> {
  const tokens = await authorize(app, installationId, { grant_type: "authorization_code", code }, fetchImpl);
  const auth = { authorization: `Bearer ${tokens.token}`, "content-type": "application/json" };
  // "Verify Install": tell Sentry we received it, or the installation stays pending.
  await fetchImpl(`${SENTRY_API}/sentry-app-installations/${encodeURIComponent(installationId)}/`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ status: "installed" }),
  });
  let org = orgFromQuery;
  if (!org) {
    // The token only reaches the one organization that installed us.
    const res = await fetchImpl(`${SENTRY_API}/organizations/`, { headers: auth });
    const orgs = res.ok ? ((await res.json()) as Array<{ slug: string }>) : [];
    org = orgs[0]?.slug ?? null;
  }
  if (!org) throw new Error("Couldn't tell which Sentry organization installed No Repro.");
  return { installationId, org, ...tokens };
}

/** Refreshes the token when it's within 5 minutes of expiring. Returns the (possibly updated) installation. */
export async function freshInstallation(app: SentryAppConfig, inst: SentryInstallation, fetchImpl: Fetch = fetch, now = Date.now()): Promise<SentryInstallation> {
  if (new Date(inst.expiresAt).getTime() - now > 5 * 60_000) return inst;
  const tokens = await authorize(app, inst.installationId, { grant_type: "refresh_token", refresh_token: inst.refreshToken }, fetchImpl);
  return { ...inst, ...tokens };
}

// ---------- API reads ----------

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  permalink: string;
  count: string | number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  firstRelease?: { version: string } | null;
  lastRelease?: { version: string } | null;
}

export interface SentryFrame {
  filename?: string | null;
  absPath?: string | null;
  lineNo?: number | null;
  function?: string | null;
  inApp?: boolean | null;
}

export interface SentryEvent {
  eventID?: string;
  dateCreated?: string;
  message?: string;
  entries: Array<{ type: string; data: any }>;
  tags: Array<{ key: string; value: string }>;
  contexts?: Record<string, any>;
  release?: { version: string } | null;
}

export class SentryClient {
  constructor(
    private readonly token: string,
    readonly org: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${SENTRY_API}${path}`, { headers: { authorization: `Bearer ${this.token}` } });
    if (res.status === 401 || res.status === 403) throw new Error("No Repro no longer has access to this Sentry organization (was the integration uninstalled?).");
    if (!res.ok) throw new Error(`Sentry API ${path} returned HTTP ${res.status}.`);
    return (await res.json()) as T;
  }

  private org_(): string {
    return encodeURIComponent(this.org);
  }

  /** Projects in the organization, for the "Link a Sentry project" step. */
  async listProjects(): Promise<Array<{ slug: string; name: string; platform: string | null }>> {
    const data = await this.get<Array<{ slug: string; name: string; platform?: string | null }>>(`/organizations/${this.org_()}/projects/?per_page=100`);
    return data.map((p) => ({ slug: p.slug, name: p.name, platform: p.platform ?? null }));
  }

  async environments(projectSlug: string): Promise<string[]> {
    const data = await this.get<Array<{ name: string }>>(`/projects/${this.org_()}/${encodeURIComponent(projectSlug)}/environments/`);
    return data.map((e) => e.name);
  }

  async projectId(slug: string): Promise<string> {
    return (await this.get<{ id: string }>(`/projects/${this.org_()}/${encodeURIComponent(slug)}/`)).id;
  }

  /** Organization issues search (the per-project endpoint is deprecated). */
  async searchIssues(projectId: string, query: string, limit = 10): Promise<SentryIssue[]> {
    const q = new URLSearchParams({ project: projectId, query, statsPeriod: "14d", sort: "freq", limit: String(limit) });
    return this.get<SentryIssue[]>(`/organizations/${this.org_()}/issues/?${q}`);
  }

  async issue(id: string): Promise<SentryIssue> {
    return this.get<SentryIssue>(`/organizations/${this.org_()}/issues/${encodeURIComponent(id)}/`);
  }

  async latestEvent(issueId: string): Promise<SentryEvent> {
    return this.get<SentryEvent>(`/organizations/${this.org_()}/issues/${encodeURIComponent(issueId)}/events/latest/`);
  }
}
