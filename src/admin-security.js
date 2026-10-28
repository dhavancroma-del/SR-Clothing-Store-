"use strict";

const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

// Refuse to start when MFA encryption is not configured with a full AES-256 key.
const MFA_KEY = process.env.ADMIN_MFA_ENCRYPTION_KEY || "";
if (!/^[a-f0-9]{64}$/i.test(MFA_KEY)) {
  throw new Error("Set ADMIN_MFA_ENCRYPTION_KEY to a randomly generated 64-character hex key.");
}

function hashPassword(password) {
  // bcrypt's work factor makes stored account passwords expensive to brute-force.
  return bcrypt.hash(password, 12);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function encryptSecret(secret) {
  // Use a fresh nonce and authenticated encryption for every stored MFA secret.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(MFA_KEY, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${encrypted.toString("hex")}`;
}

function decryptSecret(value) {
  // Validate the stored envelope before authenticating and decrypting its contents.
  const [ivHex, tagHex, dataHex] = String(value || "").split(".");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Stored MFA secret is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(MFA_KEY, "hex"), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

function base32Decode(value) {
  // Convert the RFC 4648 alphabet into bytes for TOTP's HMAC key.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const input = String(value).replace(/=+$/g, "").toUpperCase();
  let bits = "";
  for (const character of input) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Stored MFA secret is invalid.");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, at = Date.now()) {
  // Generate the six-digit HMAC-based code for the current 30-second time step.
  const counter = Math.floor(at / 30000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(value).padStart(6, "0");
}

function verifyTotp(secret, code, at = Date.now()) {
  // Accept the adjacent time steps to tolerate small clock differences.
  if (!/^\d{6}$/.test(String(code || ""))) return false;
  return [-30000, 0, 30000].some((offset) => {
    const expected = Buffer.from(totp(secret, at + offset));
    const actual = Buffer.from(String(code));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  });
}

function base32Encode(input) {
  // Encode random key bytes in the format expected by authenticator apps.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of input) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let i = 0; i < bits.length; i += 5) output += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return output;
}

function newTotpSecret() {
  // Generate a cryptographically random secret for one-time-password enrollment.
  return base32Encode(crypto.randomBytes(20));
}

function ipAllowed(ip, configured) {
  // An empty allowlist permits all addresses; configured rules support IPv4 CIDRs.
  const rules = String(configured || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (rules.length === 0) return true;
  const normalized = String(ip || "").replace(/^::ffff:/i, "");
  const version = (value) => value.includes(":") ? 6 : 4;
  const ipv4Number = (value) => {
    const parts = value.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
    return parts.reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
  };
  return rules.some((rule) => {
    const [network, prefixText] = rule.split("/");
    if (!prefixText) return normalized === network;
    if (version(network) !== 4 || version(normalized) !== 4) return false;
    const prefix = Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const address = ipv4Number(normalized);
    const subnet = ipv4Number(network);
    if (address === null || subnet === null) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (address & mask) === (subnet & mask);
  });
}

module.exports = {
  decryptSecret,
  encryptSecret,
  hashPassword,
  ipAllowed,
  makeTotpSecret: () => base32Encode(crypto.randomBytes(20)),
  totp,
  verifyPassword,
  verifyTotp
};
