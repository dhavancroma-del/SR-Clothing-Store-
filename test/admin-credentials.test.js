"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sr-admin-credentials-"));
process.env.DB_PATH = path.join(scratch, "credentials.sqlite");
process.env.ADMIN_MFA_ENCRYPTION_KEY = "3a".repeat(32);

const { changeOwnerCredentials } = require("../src/admin-credentials");
const { hashPassword, verifyPassword } = require("../src/admin-security");
const { createRuntimeDatabase } = require("../src/runtime-database");
let db;
let ownerId;

after(async () => {
  await db?.close();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("owner credential changes update the email and password and revoke sessions", async () => {
  db = await createRuntimeDatabase();
  const passwordHash = await hashPassword("initial-owner-password");
  const now = new Date().toISOString();
  ownerId = Number((await db.prepare(`INSERT INTO users
    (email,password_hash,password_salt,role,is_active,mfa_secret,mfa_enabled,created_at)
    VALUES (? ,?,'','super_admin',1,'encrypted-mfa-secret',1,?)`)
    .run("owner@example.test", passwordHash, now)).lastInsertRowid);
  await db.prepare(`INSERT INTO sessions
    (token_hash,user_id,expires_at,last_activity_at,csrf_token,mfa_verified)
    VALUES ('old-session',?,?,?,'csrf',1)`)
    .run(ownerId, new Date(Date.now() + 3600000).toISOString(), now);

  const result = await changeOwnerCredentials(db, {
    email: "updated-owner@example.test",
    password: "a-new-owner-password"
  });

  assert.equal(result.email, "updated-owner@example.test");
  const owner = await db.prepare("SELECT * FROM users WHERE id=?").get(ownerId);
  assert.equal(owner.email, result.email);
  assert.equal(owner.password_salt, "");
  assert.equal(owner.mfa_secret, "encrypted-mfa-secret");
  assert.equal(owner.mfa_enabled, 1);
  assert.equal(await verifyPassword("a-new-owner-password", owner.password_hash), true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id=?").get(ownerId)).count, 0);
});

test("owner credential changes reject invalid input and ambiguous owner accounts", async () => {
  await assert.rejects(
    changeOwnerCredentials(db, { email: "not-an-email", password: "a-new-owner-password" }),
    /valid email/
  );
  await assert.rejects(
    changeOwnerCredentials(db, { email: "owner@example.test", password: "short" }),
    /at least 12 characters/
  );

  const passwordHash = await hashPassword("second-owner-password");
  await db.prepare(`INSERT INTO users (email,password_hash,password_salt,role,is_active,created_at)
    VALUES (? ,?,'','super_admin',1,?)`).run("second-owner@example.test", passwordHash, new Date().toISOString());
  await assert.rejects(
    changeOwnerCredentials(db, { email: "new@example.test", password: "a-new-owner-password" }),
    /exactly one active Super Admin/
  );
});
