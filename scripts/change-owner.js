"use strict";

require("dotenv").config();
const readline = require("node:readline");
const { initializeDatabase } = require("../src/database");
const { changeOwnerCredentials } = require("../src/admin-credentials");

const input = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => input.question(question, resolve));

function askHidden(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return Promise.reject(new Error("Run this command in an interactive terminal so the password stays hidden."));
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
        reject(new Error("Credential change was cancelled."));
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
  let db;
  try {
    const email = (process.argv[2] || await ask("New Super Admin email: ")).trim().toLowerCase();
    const password = await askHidden("New password (at least 12 characters): ");
    const confirmation = await askHidden("Confirm new password: ");
    if (password !== confirmation) throw new Error("The passwords do not match.");
    db = initializeDatabase();
    const result = await changeOwnerCredentials(db, { email, password });
    console.log(`Super Admin credentials updated for ${result.email}. Sign in with the new email, password, and existing authenticator.`);
  } catch (error) {
    console.error(`Super Admin credentials were not updated: ${error.message}`);
    process.exitCode = 1;
  } finally {
    db?.close();
    input.close();
  }
})();
