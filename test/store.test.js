"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { before, after, test } = require("node:test");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sr-clothing-test-"));
const origin = "http://127.0.0.1";
process.env.DB_PATH = path.join(scratch, "store.sqlite");
process.env.APP_ORIGIN = origin;

let app;
let db;
let database;
let http;
let base;
let cookie;

before(async () => {
  ({ app, db } = require("../server"));
  database = require("../src/database").initializeDatabase();
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await promisify(crypto.scrypt)("correct-horse-battery-staple", salt, 64);
  database.prepare("INSERT INTO users (email,password_hash,password_salt,created_at) VALUES (?,?,?,?)")
    .run("owner@example.test", hash.toString("hex"), salt, new Date().toISOString());
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
  db?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function call(route, { method = "GET", body, owner = false } = {}) {
  const headers = { origin, ...(body ? { "content-type": "application/json" } : {}) };
  if (owner && cookie) headers.cookie = cookie;
  const response = await fetch(base + route, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {})
  });
  const contentType = response.headers.get("content-type") || "";
  return { response, data: contentType.includes("application/json") ? await response.json() : null };
}

test("private catalog, variant checkout, stock transitions, refund, and profit stay consistent", async () => {
  const publicEmpty = await call("/api/products");
  assert.equal(publicEmpty.response.status, 200);
  assert.deepEqual(publicEmpty.data.products, []);

  const blocked = await call("/api/admin/products", { method: "POST", body: {} });
  assert.equal(blocked.response.status, 401);

  const login = await call("/api/auth/login", {
    method: "POST", body: { email: "OWNER@example.test", password: "correct-horse-battery-staple" }
  });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get("set-cookie")?.split(";")[0];
  assert.match(cookie || "", /^sr_owner=[a-f0-9]{64}$/);

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
