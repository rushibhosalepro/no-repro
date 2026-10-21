// Confirms the three planted bugs actually exist, so later replay tests have something real to find.
import { beforeEach, expect, test } from "bun:test";
import { fetchHandler } from "../demo/shoplite/server.ts";

let cookie = "";
async function call(method: string, path: string, body?: unknown) {
  const res = await fetchHandler(
    new Request(`http://shop.test${path}`, {
      method,
      headers: { "content-type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  return { status: res.status, data: (await res.json()) as any };
}

beforeEach(async () => {
  cookie = "";
  await call("POST", "/__reset");
  cookie = "";
});

test("bug 1: two quick Place Order calls create two orders", async () => {
  await call("POST", "/api/cart", { productId: "shoes" });
  await Promise.all([call("POST", "/api/orders"), call("POST", "/api/orders")]);
  expect((await call("GET", "/api/orders")).data).toHaveLength(2);
});

test("bug 2: coupon discount doesn't follow quantity changes", async () => {
  await call("POST", "/api/cart", { productId: "shoes" });
  expect((await call("POST", "/api/coupon", { code: "SAVE10" })).data.total).toBe(1800);
  const after = (await call("PATCH", "/api/cart/shoes", { qty: 2 })).data;
  expect(after.subtotal).toBe(4000);
  expect(after.total).toBe(3800); // correct would be 3600
});

test("bug 3: trailing space in search returns nothing", async () => {
  expect((await call("GET", "/api/products?q=shoes")).data).toHaveLength(1);
  expect((await call("GET", "/api/products?q=shoes%20")).data).toHaveLength(0);
});

test("sessions are isolated", async () => {
  await call("POST", "/api/cart", { productId: "tee" });
  cookie = "";
  expect((await call("GET", "/api/cart")).data.lines).toEqual([]);
});
