// Who may change things. With NOREPRO_ADMIN_PASSWORD set (a hosted demo), visitors get read-only
// pages and only someone signed in with that password can create projects, link Sentry, pause,
// or run first-time setup. Without it (local use), everyone is the admin, as before.
import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "norepro_admin";
const MAX_AGE = 7 * 24 * 3600; // seconds

export class Admin {
  constructor(private readonly password: string | undefined) {}

  get enabled(): boolean {
    return Boolean(this.password);
  }

  private sign(expires: number): string {
    return createHmac("sha256", `norepro-admin:${this.password}`).update(String(expires)).digest("base64url");
  }

  /** True when no password is configured, or the request carries a valid, unexpired session. */
  allows(req: Request, now = Date.now()): boolean {
    if (!this.password) return true;
    const raw = req.headers.get("cookie")?.match(new RegExp(`${COOKIE}=([\\w.-]+)`))?.[1];
    const [exp, sig] = raw?.split(".") ?? [];
    const expires = Number(exp);
    if (!sig || !(expires > now / 1000)) return false;
    const want = Buffer.from(this.sign(expires));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  checkPassword(candidate: string): boolean {
    if (!this.password) return false;
    const a = createHmac("sha256", "norepro-pw").update(candidate).digest();
    const b = createHmac("sha256", "norepro-pw").update(this.password).digest();
    return timingSafeEqual(a, b);
  }

  sessionCookie(secure: boolean, now = Date.now()): string {
    const expires = Math.floor(now / 1000) + MAX_AGE;
    return `${COOKIE}=${expires}.${this.sign(expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? "; Secure" : ""}`;
  }

  clearCookie(): string {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
}
