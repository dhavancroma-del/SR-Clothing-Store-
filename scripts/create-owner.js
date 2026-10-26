"use strict";

require("dotenv").config();
const readline = require("node:readline");
const { promisify } = require("node:util");
const crypto = require("node:crypto");
const { initializeDatabase } = require("../src/database");

const scrypt = promisify(crypto.scrypt);
const input = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => input.question(question, resolve));
function askHidden(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return ask(question);
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    let password = "";
    const finish = () => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onKey = (character, key = {}) => {
      if (key.ctrl && key.name === "c") {
        finish();
        reject(new Error("Owner account creation was cancelled."));
      } else if (key.name === "return") {
        finish();
        resolve(password);
      } else if (key.name === "backspace") {
        password = password.slice(0, -1);
      } else if (!key.ctrl && character && character.length === 1) {
        password += character;
      }
    };
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKey);
  });
}

(async () => {
  try {
    const email = (await ask("Owner email: ")).trim().toLowerCase();
    const password = await askHidden("Owner password (at least 12 characters): ");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Enter a valid email address.");
    }
    if (password.length < 12) {
      throw new Error("Choose a password with at least 12 characters.");
    }
    const db = initializeDatabase();
    if (db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
      throw new Error("An owner account already exists. Account self-registration is disabled.");
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = await scrypt(password, salt, 64);
    db.prepare("INSERT INTO users (email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)").run(
      email, hash.toString("hex"), salt, new Date().toISOString()
    );
    console.log(`Owner account created for ${email}. Keep your password private.`);
    db.close();
  } catch (error) {
    console.error(`Owner account not created: ${error.message}`);
    process.exitCode = 1;
  } finally {
    input.close();
  }
})();
