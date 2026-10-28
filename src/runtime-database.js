"use strict";

const fs = require("node:fs");
const path = require("node:path");

function createAdapter(execute, raw, transactionFactory, close, executeMultiple) {
  const adapter = {
    prepare(sql) {
      return {
        get: async (...args) => {
          const result = await execute(sql, args);
          return result.rows[0];
        },
        all: async (...args) => {
          const result = await execute(sql, args);
          return result.rows;
        },
        run: async (...args) => {
          const result = await execute(sql, args);
          return {
            changes: Number(result.changes || 0),
            lastInsertRowid: Number(result.lastInsertRowid || 0)
          };
        }
      };
    },
    exec: async (sql) => {
      if (raw) return raw.exec(sql);
      return executeMultiple(sql);
    },
    transaction(callback) {
      return () => transactionFactory(callback);
    },
    close
  };
  return adapter;
}

async function createRuntimeDatabase() {
  if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL) {
    throw new Error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for Vercel deployments.");
  }
  if (process.env.TURSO_DATABASE_URL) {
    if (!process.env.TURSO_AUTH_TOKEN) {
      throw new Error("Set TURSO_AUTH_TOKEN when using TURSO_DATABASE_URL.");
    }
    const { createClient } = require("@libsql/client");
    const rawClient = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN
    });
    await rawClient.execute("PRAGMA foreign_keys=ON");
    const execute = (sql, args = []) => rawClient.execute({ sql, args });
    const db = createAdapter(execute, null, async (callback) => {
      const transaction = await rawClient.transaction("write");
      const tx = createAdapter(
        (sql, args = []) => transaction.execute({ sql, args }),
        null,
        async () => { throw new Error("Nested database transactions are not supported."); },
        async () => {},
        (sql) => transaction.executeMultiple(sql)
      );
      try {
        const result = await callback(tx);
        await transaction.commit();
        return result;
      } catch (error) {
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Database transaction failed and could not be rolled back.");
        }
        throw error;
      }
    }, async () => rawClient.close(), (sql) => rawClient.executeMultiple(sql));
    await db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
    await migrate(db);
    return db;
  }

  const { initializeDatabase } = require("./database");
  const raw = initializeDatabase();
  const execute = async (sql, args = []) => {
    const statement = raw.prepare(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
      return { rows: args.length ? statement.all(...args) : statement.all(), changes: 0 };
    }
    const result = args.length ? statement.run(...args) : statement.run();
    return { rows: [], changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  };
  return createAdapter(execute, raw, async (callback) => {
    raw.exec("BEGIN IMMEDIATE");
    try {
      const result = await callback(createAdapter(execute, raw, async () => {
        throw new Error("Nested database transactions are not supported.");
      }, async () => {}, async (sql) => raw.exec(sql)));
      raw.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        raw.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Database transaction failed and could not be rolled back.");
      }
      throw error;
    }
  }, async () => raw.close(), async (sql) => raw.exec(sql));
}

async function migrate(db) {
  const additions = [
    ["users", "role", "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'super_admin'"],
    ["users", "is_active", "ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1"],
    ["users", "mfa_secret", "ALTER TABLE users ADD COLUMN mfa_secret TEXT"],
    ["users", "mfa_enabled", "ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0"],
    ["sessions", "last_activity_at", "ALTER TABLE sessions ADD COLUMN last_activity_at TEXT NOT NULL DEFAULT ''"],
    ["sessions", "csrf_token", "ALTER TABLE sessions ADD COLUMN csrf_token TEXT NOT NULL DEFAULT ''"],
    ["sessions", "mfa_verified", "ALTER TABLE sessions ADD COLUMN mfa_verified INTEGER NOT NULL DEFAULT 0"],
    ["products", "sizes_json", "ALTER TABLE products ADD COLUMN sizes_json TEXT NOT NULL DEFAULT '[\"S\",\"M\",\"L\",\"XL\"]'"],
    ["order_items", "size", "ALTER TABLE order_items ADD COLUMN size TEXT NOT NULL DEFAULT ''"],
    ["order_items", "color", "ALTER TABLE order_items ADD COLUMN color TEXT NOT NULL DEFAULT ''"]
  ];
  await db.transaction(async (tx) => {
    for (const [table, column, sql] of additions) {
      const columns = await tx.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((entry) => entry.name === column)) await tx.exec(sql);
    }
  })();
}

module.exports = { createRuntimeDatabase };
