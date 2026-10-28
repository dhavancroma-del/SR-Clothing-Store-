"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, after, test } = require("node:test");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sr-clothing-test-"));
const origin = "http://127.0.0.1";
process.env.DB_PATH = path.join(scratch, "store.sqlite");
process.env.APP_ORIGIN = origin;
process.env.ADMIN_MFA_ENCRYPTION_KEY = "3a".repeat(32);
process.env.ADMIN_IP_ALLOWLIST = "127.0.0.1";

const { decryptSecret, encryptSecret, hashPassword, makeTotpSecret, totp } = require("../src/admin-security");

let app;
let db;
let database;
let http;
let base;
let cookie;
let csrfToken;

before(async () => {
  const server = require("../server");
  app = server.app;
  db = await server.databaseReady;
  database = require("../src/database").initializeDatabase();
  const hash = await hashPassword("correct-horse-battery-staple");
  const secret = makeTotpSecret();
  database.prepare(`INSERT INTO users
    (email,password_hash,password_salt,role,mfa_secret,mfa_enabled,created_at)
    VALUES (?,?,?,'super_admin',?,1,?)`)
    .run("owner@example.test", hash, "", encryptSecret(secret), new Date().toISOString());
  await new Promise((resolve) => {
    http = app.listen(0, "127.0.0.1", resolve);
    http.on("error", (error) => { throw error; });
  });
  base = `${origin}:${http.address().port}`;
});

after(async () => {
  if (http?.listening) {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
  database?.close();
  await db?.close();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function call(route, { method = "GET", body, owner = false, csrf = true, cookieValue, csrfValue } = {}) {
  const headers = { origin, ...(body ? { "content-type": "application/json" } : {}) };
  if (owner && (cookieValue || cookie)) headers.cookie = cookieValue || cookie;
  if (owner && csrf && (csrfValue || csrfToken)) headers["x-csrf-token"] = csrfValue || csrfToken;
  const response = await fetch(base + route, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {})
  });
  const contentType = response.headers.get("content-type") || "";
  return { response, data: contentType.includes("application/json") ? await response.json() : null };
}

test("private catalog, variant checkout, stock transitions, refund, and profit stay consistent", async () => {
  const publicPage = await fetch(base + "/");
  assert.equal(publicPage.status, 200);
  const storefront = await publicPage.text();
  assert.doesNotMatch(storefront, /id="admin-view"|THE STUDIO|href=["']\/admin/);
  assert.equal((storefront.match(/data-admin-entry/g) || []).length, 2);
  assert.equal((await call("/admin")).response.status, 404);
  assert.equal((await call("/admin/login")).response.status, 200);
  assert.equal((await call("/api/auth/register", { method: "POST", body: { email: "public@example.test" } })).response.status, 404);

  const publicEmpty = await call("/api/products");
  assert.equal(publicEmpty.response.status, 200);
  assert.deepEqual(publicEmpty.data.products, []);

  const blocked = await call("/api/admin/products", { method: "POST", body: {} });
  assert.equal(blocked.response.status, 404);

  const login = await call("/api/auth/login", {
    method: "POST", body: { email: "OWNER@example.test", password: "correct-horse-battery-staple" }
  });
  assert.equal(login.response.status, 401);
  const owner = database.prepare("SELECT mfa_secret FROM users WHERE email=?").get("owner@example.test");
  const ownerOtp = totp(decryptSecret(owner.mfa_secret));
  const goodLogin = await call("/api/auth/login", {
    method: "POST", body: { email: "OWNER@example.test", password: "correct-horse-battery-staple", otp: ownerOtp }
  });
  assert.equal(goodLogin.response.status, 200);
  cookie = goodLogin.response.headers.get("set-cookie")?.split(";")[0];
  csrfToken = goodLogin.data.csrfToken;
  assert.match(cookie || "", /^sr_owner=[a-f0-9]{64}$/);
  const allowedIps = process.env.ADMIN_IP_ALLOWLIST;
  process.env.ADMIN_IP_ALLOWLIST = "192.0.2.1";
  assert.equal((await call("/api/admin/orders", { owner: true })).response.status, 404);
  process.env.ADMIN_IP_ALLOWLIST = allowedIps;

  const csrfBlocked = await call("/api/admin/products", { method: "POST", owner: true, csrf: false, body: {} });
  assert.equal(csrfBlocked.response.status, 403);

  const created = await call("/api/admin/products", {
    method: "POST", owner: true,
    body: {
      sku: "SR-TEST-001", name: "Test cotton shirt", category: "Men",
      description: "A test-only product", image: "", cost: 500, price: 800,
      stock: 10, minStock: 5, sizes: ["S", "M", "L"], colors: ["#111111"]
    }
  });
  assert.equal(created.response.status, 201);
  const productId = created.data.product.id;

  const publicProduct = await call("/api/products");
  const [listed] = publicProduct.data.products;
  assert.equal(listed.id, productId);
  assert.equal("cost" in listed, false);
  assert.equal("supplier" in listed, false);
  assert.equal("minStock" in listed, false);

  const invalidSize = await call("/api/orders", {
    method: "POST",
    body: {
      customerName: "Test Customer", email: "customer@example.test",
      phone: "+919876543210", address: "123 Example Road, Pune, Maharashtra",
      paymentMethod: "COD", items: [{ productId, quantity: 1, size: "XXXL", color: "#111111" }]
    }
  });
  assert.equal(invalidSize.response.status, 400);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);

  async function placeOrder(quantity = 1) {
    const result = await call("/api/orders", {
      method: "POST",
      body: {
        customerName: "Test Customer", email: "customer@example.test",
        phone: "+919876543210", address: "123 Example Road, Pune, Maharashtra",
        paymentMethod: "COD", items: [{ productId, quantity, size: "M", color: "#111111" }]
      }
    });
    assert.equal(result.response.status, 201);
    assert.equal("cogs" in result.data.order, false);
    assert.equal("cost" in result.data.order.items[0], false);
    assert.equal(result.data.order.total, 899);
    return result.data.order.id;
  }

  async function status(id, value, restock = false) {
    return call(`/api/admin/orders/${encodeURIComponent(id)}`, {
      method: "PATCH", owner: true, body: { status: value, restock }
    });
  }

  const cancelledId = await placeOrder();
  assert.equal(database.prepare("SELECT stock FROM products WHERE id=?").get(productId).stock, 10);
  assert.equal((await status(cancelledId, "Confirmed")).response.status, 200);
  assert.equal(database.prepare("SELECT stock FROM products WHERE id=?").get(productId).stock, 9);
  assert.equal((await status(cancelledId, "Cancelled")).response.status, 200);
  assert.equal(database.prepare("SELECT stock FROM products WHERE id=?").get(productId).stock, 10);

  const deliveredId = await placeOrder();
  for (const next of ["Confirmed", "Processing", "Shipped", "Delivered"]) {
    const result = await status(deliveredId, next);
    assert.equal(result.response.status, 200);
  }
  assert.equal(database.prepare("SELECT stock FROM products WHERE id=?").get(productId).stock, 9);

  const expense = await call("/api/admin/expenses", {
    method: "POST", owner: true,
    body: {
      category: "Packaging", amount: 125, description: "Test operating expense",
      reference: "TEST-1", date: new Date().toISOString().slice(0, 10)
    }
  });
  assert.equal(expense.response.status, 201);

  let overview = await call("/api/admin/overview?days=30", { owner: true });
  assert.deepEqual(
    [overview.data.revenue, overview.data.purchaseCost, overview.data.grossProfit, overview.data.expenses, overview.data.netProfit],
    [899, 500, 399, 125, 274]
  );

  const refund = await status(deliveredId, "Refunded", true);
  assert.equal(refund.response.status, 200);
  assert.equal(refund.data.order.paymentStatus, "Refunded");
  assert.equal(database.prepare("SELECT stock FROM products WHERE id=?").get(productId).stock, 10);
  overview = await call("/api/admin/overview?days=30", { owner: true });
  assert.deepEqual([overview.data.revenue, overview.data.purchaseCost, overview.data.grossProfit], [0, 0, 0]);

  const duplicateSku = await call("/api/admin/products", {
    method: "POST", owner: true,
    body: {
      sku: "sr-test-001", name: "Another shirt", category: "Men",
      cost: 500, price: 800, stock: 2
    }
  });
  assert.equal(duplicateSku.response.status, 409);
});

test("staff access requires a one-use invitation, MFA enrollment, and assigned permissions", async () => {
  const invitation = await call("/api/admin/invitations", {
    method: "POST", owner: true,
    body: { email: "staff@example.test", role: "staff" }
  });
  assert.equal(invitation.response.status, 201);
  const token = new URL(invitation.data.invitation.url, base).searchParams.get("token");
  assert.match(token, /^[a-f0-9]{64}$/);

  const accepted = await call("/api/auth/invitations/accept", {
    method: "POST", body: { token, password: "staff-password-2026" }
  });
  assert.equal(accepted.response.status, 201);
  const staffCookie = accepted.response.headers.get("set-cookie")?.split(";")[0];
  const staffCsrf = accepted.data.csrfToken;
  assert.equal(accepted.data.user.mfaEnabled, false);
  assert.equal((await call("/api/admin/products", { owner: true, cookieValue: staffCookie, csrfValue: staffCsrf })).response.status, 404);

  const setup = await call("/api/auth/mfa/setup", { owner: true, cookieValue: staffCookie });
  assert.equal(setup.response.status, 200);
  const setupAgain = await call("/api/auth/mfa/setup", { owner: true, cookieValue: staffCookie });
  assert.equal(setupAgain.data.secret, setup.data.secret);
  const enrolled = await call("/api/auth/mfa/verify", {
    method: "POST", owner: true, cookieValue: staffCookie, csrfValue: staffCsrf,
    body: { otp: totp(setup.data.secret) }
  });
  assert.equal(enrolled.response.status, 200);
  const enrolledCsrf = enrolled.data.csrfToken;
  assert.equal((await call("/admin", { owner: true, cookieValue: staffCookie })).response.status, 200);
  const staffOrders = await call("/api/admin/orders", {
    owner: true, cookieValue: staffCookie, csrfValue: enrolledCsrf
  });
  assert.equal(staffOrders.response.status, 200);
  if (staffOrders.data.orders.length) {
    assert.equal("cogs" in staffOrders.data.orders[0], false);
    assert.equal("cost" in staffOrders.data.orders[0].items[0], false);
  }
  assert.equal((await call("/api/admin/products", {
    owner: true, cookieValue: staffCookie, csrfValue: enrolledCsrf
  })).response.status, 403);
  assert.equal((await call("/api/admin/users", {
    owner: true, cookieValue: staffCookie, csrfValue: enrolledCsrf
  })).response.status, 403);

  const productWrite = await call("/api/admin/products", {
    method: "POST", owner: true, cookieValue: staffCookie, csrfValue: enrolledCsrf,
    body: {
      sku: "SR-STAFF-001", name: "Restricted shirt", category: "Men",
      cost: 100, price: 200, stock: 1
    }
  });
  assert.equal(productWrite.response.status, 403);
  const reused = await call("/api/auth/invitations/accept", {
    method: "POST", body: { token, password: "different-staff-password" }
  });
  assert.equal(reused.response.status, 400);

  const rawOwnerToken = cookie.slice("sr_owner=".length);
  const ownerSessionHash = crypto.createHash("sha256").update(rawOwnerToken).digest("hex");
  database.prepare("UPDATE sessions SET last_activity_at=? WHERE token_hash=?")
    .run(new Date(Date.now() - 21 * 60 * 1000).toISOString(), ownerSessionHash);
  assert.equal((await call("/api/admin/orders", { owner: true })).response.status, 404);
});
