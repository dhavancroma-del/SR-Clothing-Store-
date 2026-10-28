"use strict";

const crypto = require("node:crypto");
const { hashPassword } = require("./admin-security");

// Change credentials only when there is exactly one active Super Admin.
async function changeOwnerCredentials(db, { email, password }) {
  // Normalize the address and reject passwords outside the hashing policy first.
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const passwordBytes = Buffer.byteLength(String(password || ""), "utf8");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("Enter a valid email address.");
  }
  if (String(password || "").length < 12 || passwordBytes > 72) {
    throw new Error("Choose a password with at least 12 characters and no more than 72 UTF-8 bytes.");
  }

  const owners = db.prepare("SELECT id FROM users WHERE role='super_admin' AND is_active=1").all();
  if (owners.length !== 1) {
    throw new Error("Credential changes require exactly one active Super Admin account.");
  }
  // Check collisions before expensive hashing, then repeat the checks inside the transaction.
  const ownerId = owners[0].id;
  const collision = db.prepare("SELECT 1 FROM users WHERE email=? AND id<>?").get(normalizedEmail, ownerId);
  if (collision) throw new Error("That email address is already assigned to another account.");

  const passwordHash = await hashPassword(String(password));
  const update = db.transaction(() => {
    // Protect against account changes that occur while the password hash is generated.
    const currentOwners = db.prepare("SELECT id FROM users WHERE role='super_admin' AND is_active=1").all();
    if (currentOwners.length !== 1 || currentOwners[0].id !== ownerId) {
      throw new Error("The active Super Admin account changed. No credentials were updated.");
    }
    if (db.prepare("SELECT 1 FROM users WHERE email=? AND id<>?").get(normalizedEmail, ownerId)) {
      throw new Error("That email address is already assigned to another account.");
    }
    db.prepare("UPDATE users SET email=?,password_hash=?,password_salt='' WHERE id=?")
      .run(normalizedEmail, passwordHash, ownerId);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(ownerId);
  });
  update();
  // Keep the existing MFA enrollment intact while invalidating all prior sessions.
  return { email: normalizedEmail };
}

module.exports = { changeOwnerCredentials };
