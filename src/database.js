"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

function initializeDatabase() {
  const filename = path.resolve(process.env.DB_PATH || "./data/sr-clothing.sqlite");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      cost_paise INTEGER NOT NULL CHECK (cost_paise >= 0),
      price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
      discount_paise INTEGER CHECK (discount_paise IS NULL OR discount_paise >= 0),
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      min_stock INTEGER NOT NULL DEFAULT 5 CHECK (min_stock >= 0),
      supplier TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Draft','Out of Stock')),
      colors_json TEXT NOT NULL DEFAULT '[]',
      sizes_json TEXT NOT NULL DEFAULT '["S","M","L","XL"]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'Unpaid',
      status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending','Confirmed','Processing','Shipped','Delivered','Cancelled','Refunded')),
      subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise >= 0),
      shipping_paise INTEGER NOT NULL DEFAULT 0 CHECK (shipping_paise >= 0),
      discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
      total_paise INTEGER NOT NULL CHECK (total_paise >= 0),
      reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved IN (0,1)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES orders(id),
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      size TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
      unit_cost_paise INTEGER NOT NULL CHECK (unit_cost_paise >= 0),
      UNIQUE (order_id, product_id, size, color)
    );
    CREATE INDEX IF NOT EXISTS order_created ON orders(created_at);
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
      description TEXT NOT NULL,
      reference TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      sku TEXT NOT NULL,
      change_quantity INTEGER NOT NULL,
      reason TEXT NOT NULL,
      reference TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  const productColumns = new Set(db.prepare("PRAGMA table_info(products)").all().map((column) => column.name));
  if (!productColumns.has("sizes_json")) db.exec("ALTER TABLE products ADD COLUMN sizes_json TEXT NOT NULL DEFAULT '[\"S\",\"M\",\"L\",\"XL\"]'");
  const itemColumns = new Set(db.prepare("PRAGMA table_info(order_items)").all().map((column) => column.name));
  if (!itemColumns.has("size")) db.exec("ALTER TABLE order_items ADD COLUMN size TEXT NOT NULL DEFAULT ''");
  if (!itemColumns.has("color")) db.exec("ALTER TABLE order_items ADD COLUMN color TEXT NOT NULL DEFAULT ''");
  return db;
}

module.exports = { initializeDatabase };
