"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

function initializeDatabase() {
  // Resolve the configured store file and ensure its parent directory exists.
  const filename = path.resolve(process.env.DB_PATH || "./data/sr-clothing.sqlite");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    -- Accounts and sessions support role-based access and MFA-protected sign-in.
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'super_admin'
        CHECK (role IN ('super_admin','admin','staff')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      mfa_secret TEXT,
      mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0,1)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL DEFAULT '',
      csrf_token TEXT NOT NULL DEFAULT '',
      mfa_verified INTEGER NOT NULL DEFAULT 0 CHECK (mfa_verified IN (0,1))
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS admin_invitations (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('admin','staff')),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS invitations_expiry ON admin_invitations(expires_at, accepted_at);
    -- Product records keep all monetary values in paise to avoid rounding errors.
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
    -- Order line snapshots preserve purchased prices and costs if products later change.
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
  // Apply additive migrations for databases created by earlier application versions.
  const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
  if (!userColumns.has("role")) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'super_admin'");
  if (!userColumns.has("is_active")) db.exec("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1");
  if (!userColumns.has("mfa_secret")) db.exec("ALTER TABLE users ADD COLUMN mfa_secret TEXT");
  if (!userColumns.has("mfa_enabled")) db.exec("ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0");
  const sessionColumns = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name));
  if (!sessionColumns.has("last_activity_at")) db.exec("ALTER TABLE sessions ADD COLUMN last_activity_at TEXT NOT NULL DEFAULT ''");
  if (!sessionColumns.has("csrf_token")) db.exec("ALTER TABLE sessions ADD COLUMN csrf_token TEXT NOT NULL DEFAULT ''");
  if (!sessionColumns.has("mfa_verified")) db.exec("ALTER TABLE sessions ADD COLUMN mfa_verified INTEGER NOT NULL DEFAULT 0");
  const productColumns = new Set(db.prepare("PRAGMA table_info(products)").all().map((column) => column.name));
  if (!productColumns.has("sizes_json")) db.exec("ALTER TABLE products ADD COLUMN sizes_json TEXT NOT NULL DEFAULT '[\"S\",\"M\",\"L\",\"XL\"]'");
  const itemColumns = new Set(db.prepare("PRAGMA table_info(order_items)").all().map((column) => column.name));
  if (!itemColumns.has("size")) db.exec("ALTER TABLE order_items ADD COLUMN size TEXT NOT NULL DEFAULT ''");
  if (!itemColumns.has("color")) db.exec("ALTER TABLE order_items ADD COLUMN color TEXT NOT NULL DEFAULT ''");
  return db;
}

module.exports = { initializeDatabase };
