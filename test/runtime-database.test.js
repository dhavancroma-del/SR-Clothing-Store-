"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRuntimeDatabase } = require("../src/runtime-database");

test("Vercel refuses to fall back to an ephemeral SQLite database", async () => {
  const previous = {
    vercel: process.env.VERCEL,
    url: process.env.TURSO_DATABASE_URL,
    token: process.env.TURSO_AUTH_TOKEN
  };
  process.env.VERCEL = "1";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  try {
    await assert.rejects(
      createRuntimeDatabase(),
      /Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for Vercel deployments/
    );
  } finally {
    if (previous.vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous.vercel;
    if (previous.url === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = previous.url;
    if (previous.token === undefined) delete process.env.TURSO_AUTH_TOKEN;
    else process.env.TURSO_AUTH_TOKEN = previous.token;
  }
});
