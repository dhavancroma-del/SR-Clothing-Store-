"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");
require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");
const { initializeDatabase } = require("./src/database");
const {
  decryptSecret, encryptSecret, hashPassword, ipAllowed, makeTotpSecret,
  verifyPassword, verifyTotp
} = require("./src/admin-security");

const app = express();
const db = initializeDatabase();
const scrypt = promisify(crypto.scrypt);
const APP_ORIGIN = process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000";
const SESSION_MS = 8 * 60 * 60 * 1000;
const IDLE_SESSION_MS = 20 * 60 * 1000;
const COOKIE = "sr_owner";
const ADMIN_DIR = require("node:path").join(__dirname, "private-admin");
const money = z.number().finite().nonnegative().max(100000000);
const idNumber = z.coerce.number().int().positive();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const orderStatuses = ["Confirmed", "Processing", "Shipped", "Delivered", "Cancelled", "Refunded"];

app.disable("x-powered-by");
const trustedProxyHops = Number(process.env.TRUST_PROXY);
app.set("trust proxy", Number.isInteger(trustedProxyHops) && trustedProxyHops > 0 ? trustedProxyHops : false);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "same-site" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null
    }
  }
}));
app.use(express.json({ limit: "32kb", strict: true }));
app.use("/api/auth", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use("/api/auth/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false }));
app.use("/api/auth/mfa/verify", rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false }));
app.use("/api/auth/invitations/accept", rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false }));
app.use("/api/orders", rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false }));

const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: SESSION_MS };
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const moneyToPaise = (value) => Math.round(value * 100);
const paiseToRupees = (value) => Number((value / 100).toFixed(2));
const fail = (status, message) => Object.assign(new Error(message), { status });

function validate(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw fail(400, result.error.issues.map((issue) => issue.message).join("; "));
  return result.data;
}

function guardSameOrigin(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.get("origin");
  if (!origin || origin !== APP_ORIGIN) return res.status(403).json({ error: "This request did not come from the store." });
  return next();
}
app.use("/api", guardSameOrigin);

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const i = part.indexOf("=");
    return [decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))];
  }));
}
function rawSessionToken(req) {
  const raw = parseCookies(req.get("cookie"))[COOKIE];
  return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}
function getSession(req) {
  const raw = rawSessionToken(req);
  if (!raw) return null;
  return db.prepare(`
    SELECT u.id, u.email, u.role, u.is_active, u.mfa_enabled, u.mfa_secret,
      s.token_hash, s.expires_at, s.last_activity_at, s.csrf_token, s.mfa_verified
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?
  `).get(sha256(raw));
}
function adminIpAllowed(req) {
  return ipAllowed(req.ip, process.env.ADMIN_IP_ALLOWLIST);
}
function hidden(res) {
  return res.status(404).send("Not found");
}
function issueSession(user, mfaVerified) {
  const now = new Date();
  const token = crypto.randomBytes(32).toString("hex");
  const csrfToken = crypto.randomBytes(32).toString("hex");
  const expires = new Date(now.getTime() + SESSION_MS).toISOString();
  db.prepare("DELETE FROM sessions WHERE expires_at<=? OR last_activity_at<=?")
    .run(now.toISOString(), new Date(now.getTime() - IDLE_SESSION_MS).toISOString());
  db.prepare(`INSERT INTO sessions
    (token_hash,user_id,expires_at,last_activity_at,csrf_token,mfa_verified)
    VALUES (?,?,?,?,?,?)`)
    .run(sha256(token), user.id, expires, now.toISOString(), csrfToken, mfaVerified ? 1 : 0);
  return { token, csrfToken, expires };
}
function sessionValid(session) {
  if (!session || !session.is_active) return false;
  const now = Date.now();
  return Date.parse(session.expires_at) > now &&
    Date.parse(session.last_activity_at || 0) > now - IDLE_SESSION_MS;
}
function requireOwner(req, res, next) {
  if (!adminIpAllowed(req)) return hidden(res);
  const session = getSession(req);
  if (!sessionValid(session) || !["super_admin", "admin", "staff"].includes(session.role)) {
    if (session) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(session.token_hash);
    res.clearCookie(COOKIE, cookieOptions);
    return hidden(res);
  }
  if (!session.mfa_enabled || !session.mfa_verified) return hidden(res);
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const supplied = Buffer.from(req.get("x-csrf-token") || "");
    const expected = Buffer.from(session.csrf_token || "");
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(403).json({ error: "This request could not be verified. Reload the page and try again." });
    }
  }
  const activity = new Date().toISOString();
  db.prepare("UPDATE sessions SET last_activity_at=? WHERE token_hash=?").run(activity, session.token_hash);
  req.admin = { id: session.id, email: session.email, role: session.role, session };
  next();
}
function requirePermission(permission) {
  const rolePermissions = {
    super_admin: ["*"],
    admin: ["products.read", "products.write", "inventory.read", "inventory.adjust", "orders.read", "orders.update", "expenses.read", "expenses.write", "reports.read", "admins.read"],
    staff: ["orders.read", "orders.update"]
  };
  return (req, res, next) => {
    const permissions = rolePermissions[req.admin?.role] || [];
    if (permission === "orders.update" && req.admin?.role === "staff" && req.body?.status === "Refunded") {
      return res.status(403).json({ error: "Staff cannot issue refunds." });
    }
    if (!permissions.includes("*") && !permissions.includes(permission)) {
      return res.status(403).json({ error: "Your account is not permitted to perform this action." });
    }
    next();
  };
}
function requireSuperAdmin(req, res, next) {
  if (req.admin?.role !== "super_admin") return res.status(403).json({ error: "Super Admin access is required." });
  next();
}
function requirePendingMfa(req, res, next) {
  if (!adminIpAllowed(req)) return hidden(res);
  const session = getSession(req);
  if (!sessionValid(session) || session.mfa_enabled || session.mfa_verified) return hidden(res);
  req.pendingAdmin = session;
  next();
}
function verifyPendingCsrf(req, res, next) {
  const supplied = Buffer.from(req.get("x-csrf-token") || "");
  const expected = Buffer.from(req.pendingAdmin.csrf_token || "");
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.status(403).json({ error: "This request could not be verified. Reload the page and try again." });
  }
  next();
}
function publicProduct(row) {
  return {
    id: row.id, sku: row.sku, name: row.name, category: row.category, description: row.description,
    image: row.image, price: paiseToRupees(row.price_paise),
    ...(row.discount_paise !== null ? { discountPrice: paiseToRupees(row.discount_paise) } : {}),
    cost: paiseToRupees(row.cost_paise), stock: row.stock, minStock: row.min_stock,
    supplier: row.supplier, tag: row.stock <= row.min_stock ? "LOW STOCK" : "THOUGHTFULLY CHOSEN",
    colors: JSON.parse(row.colors_json), sizes: JSON.parse(row.sizes_json), status: row.status
  };
}
function storefrontProduct(row) {
  return {
    id: row.id, sku: row.sku, name: row.name, category: row.category, description: row.description,
    image: row.image, price: paiseToRupees(row.price_paise),
    ...(row.discount_paise !== null ? { discountPrice: paiseToRupees(row.discount_paise) } : {}),
    stock: row.stock, sizes: JSON.parse(row.sizes_json), colors: JSON.parse(row.colors_json),
    tag: row.stock <= row.min_stock ? "LOW STOCK" : "THOUGHTFULLY CHOSEN"
  };
}
function ownerProductQuery() { return db.prepare("SELECT * FROM products ORDER BY id DESC").all(); }
function presentOrder(row) {
  const items = db.prepare("SELECT product_id AS productId, sku, name, size, color, quantity, unit_price_paise AS unitPrice, unit_cost_paise AS unitCost FROM order_items WHERE order_id = ?").all(row.id).map((i) => ({
    productId: i.productId, sku: i.sku, name: i.name, size: i.size, color: i.color, quantity: i.quantity, price: paiseToRupees(i.unitPrice),
    cost: paiseToRupees(i.unitCost)
  }));
  const cogs = db.prepare("SELECT COALESCE(SUM(unit_cost_paise * quantity),0) AS amount FROM order_items WHERE order_id = ?").get(row.id).amount;
  return {
    id: row.id, customerName: row.customer_name, email: row.email, phone: row.phone,
    address: row.address, paymentMethod: row.payment_method, paymentStatus: row.payment_status,
    status: row.status, subtotal: paiseToRupees(row.subtotal_paise), shipping: paiseToRupees(row.shipping_paise),
    discount: paiseToRupees(row.discount_paise), total: paiseToRupees(row.total_paise),
    reserved: Boolean(row.reserved), items, cogs: paiseToRupees(cogs), createdAt: row.created_at
  };
}
function customerOrderConfirmation(row) {
  const { cogs, ...order } = presentOrder(row);
  return { ...order, items: order.items.map(({ cost, ...item }) => item) };
}
function presentAdminOrder(row, role) {
  return role === "staff" ? customerOrderConfirmation(row) : presentOrder(row);
}

app.get("/api/auth/session", (req, res) => {
  const row = getSession(req);
  if (!sessionValid(row) || !adminIpAllowed(req)) {
    if (row) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(row.token_hash);
    return res.json({ user: null });
  }
  db.prepare("UPDATE sessions SET last_activity_at=? WHERE token_hash=?").run(new Date().toISOString(), row.token_hash);
  res.json({
    user: row.mfa_enabled && row.mfa_verified
      ? { email: row.email, role: row.role, mfaEnabled: true, mfaVerified: true }
      : null,
    csrfToken: row.csrf_token
  });
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    if (!adminIpAllowed(req)) return hidden(res);
    const data = validate(z.object({
      email: z.string().email().max(254).transform((v) => v.toLowerCase()),
      password: z.string().min(1).max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 UTF-8 bytes."),
      otp: z.string().regex(/^\d{6}$/).optional()
    }).strict(), req.body);
    const user = db.prepare("SELECT * FROM users WHERE email=?").get(data.email);
    let passwordMatches = false;
    if (user?.is_active && /^\$2[aby]\$/.test(user.password_hash)) {
      passwordMatches = await verifyPassword(data.password, user.password_hash);
    } else if (user?.is_active) {
      const candidate = await scrypt(data.password, user.password_salt, 64);
      const stored = Buffer.from(user.password_hash, "hex");
      passwordMatches = candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
      if (passwordMatches) {
        const upgradedHash = await hashPassword(data.password);
        db.prepare("UPDATE users SET password_hash=?,password_salt='' WHERE id=?").run(upgradedHash, user.id);
      }
    }
    if (!passwordMatches) {
      throw fail(401, "That email or password isn’t quite right.");
    }
    if (user.mfa_enabled && (!data.otp || !verifyTotp(decryptSecret(user.mfa_secret), data.otp))) {
      throw fail(401, "That email, password, or authenticator code isn’t quite right.");
    }
    const session = issueSession(user, Boolean(user.mfa_enabled));
    res.cookie(COOKIE, session.token, cookieOptions).json({
      user: { email: user.email, role: user.role, mfaEnabled: Boolean(user.mfa_enabled) },
      csrfToken: session.csrfToken,
      expiresAt: session.expires
    });
  } catch (error) { next(error); }
});

app.post("/api/auth/logout", (req, res) => {
  const raw = rawSessionToken(req);
  if (raw) {
    const session = db.prepare("SELECT csrf_token FROM sessions WHERE token_hash=?").get(sha256(raw));
    if (session) {
      const supplied = Buffer.from(req.get("x-csrf-token") || "");
      const expected = Buffer.from(session.csrf_token || "");
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        return res.status(403).json({ error: "This request could not be verified. Reload the page and try again." });
      }
      db.prepare("DELETE FROM sessions WHERE token_hash=?").run(sha256(raw));
    }
  }
  res.clearCookie(COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/" }).status(204).end();
});

app.get("/api/auth/mfa/setup", requirePendingMfa, (req, res, next) => {
  try {
    let secret = req.pendingAdmin.mfa_secret;
    if (!secret) {
      secret = encryptSecret(makeTotpSecret());
      db.prepare("UPDATE users SET mfa_secret=? WHERE id=?").run(secret, req.pendingAdmin.id);
    }
    const plain = decryptSecret(secret);
    const label = encodeURIComponent(`SR CLOTHING:${req.pendingAdmin.email}`);
    const issuer = encodeURIComponent("SR CLOTHING");
    res.json({
      secret: plain,
      otpauthUrl: `otpauth://totp/${label}?secret=${plain}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
      csrfToken: req.pendingAdmin.csrf_token
    });
  } catch (error) { next(error); }
});

app.post("/api/auth/mfa/verify", requirePendingMfa, verifyPendingCsrf, (req, res, next) => {
  try {
    const { otp } = validate(z.object({ otp: z.string().regex(/^\d{6}$/) }).strict(), req.body);
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.pendingAdmin.id);
    if (!user.mfa_secret || !verifyTotp(decryptSecret(user.mfa_secret), otp)) {
      throw fail(400, "That authenticator code is not valid. Check your device clock and try again.");
    }
    const csrfToken = crypto.randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare("UPDATE users SET mfa_enabled=1 WHERE id=?").run(user.id);
      db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash!=?").run(user.id, req.pendingAdmin.token_hash);
      db.prepare("UPDATE sessions SET mfa_verified=1,csrf_token=?,last_activity_at=? WHERE token_hash=?")
        .run(csrfToken, now, req.pendingAdmin.token_hash);
    })();
    res.json({ user: { email: user.email, role: user.role, mfaEnabled: true }, csrfToken });
  } catch (error) { next(error); }
});

app.post("/api/auth/invitations/accept", async (req, res, next) => {
  try {
    if (!adminIpAllowed(req)) return hidden(res);
    const input = validate(z.object({
      token: z.string().regex(/^[a-f0-9]{64}$/),
      password: z.string().min(12).max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 UTF-8 bytes.")
    }).strict(), req.body);
    const tokenHash = sha256(input.token);
    const invitation = db.prepare("SELECT * FROM admin_invitations WHERE token_hash=? AND accepted_at IS NULL AND expires_at>?")
      .get(tokenHash, new Date().toISOString());
    if (!invitation) throw fail(400, "This invitation is invalid or has expired.");
    if (db.prepare("SELECT 1 FROM users WHERE email=?").get(invitation.email)) {
      throw fail(409, "An account already exists for this invitation.");
    }
    const passwordHash = await hashPassword(input.password);
    const now = new Date().toISOString();
    const accept = db.transaction(() => {
      const current = db.prepare("SELECT * FROM admin_invitations WHERE id=? AND accepted_at IS NULL AND expires_at>?").get(invitation.id, now);
      if (!current) throw fail(409, "This invitation has already been used or has expired.");
      const result = db.prepare(`INSERT INTO users
        (email,password_hash,password_salt,role,is_active,created_at)
        VALUES (?,?, '', ?,1,?)`).run(current.email, passwordHash, current.role, now);
      db.prepare("UPDATE admin_invitations SET accepted_at=? WHERE id=?").run(now, current.id);
      return { id: result.lastInsertRowid, email: current.email, role: current.role };
    });
    const user = accept();
    const session = issueSession(user, false);
    res.cookie(COOKIE, session.token, cookieOptions).status(201).json({
      user: { email: user.email, role: user.role, mfaEnabled: false },
      csrfToken: session.csrfToken
    });
  } catch (error) { next(error); }
});

app.get("/api/products", (req, res) => {
  const products = db.prepare("SELECT * FROM products WHERE status='Active' AND stock>0 ORDER BY id DESC").all().map(storefrontProduct);
  res.json({ products });
});

const createOrderBody = z.object({
  customerName: z.string().trim().min(2).max(120),
  email: z.string().email().max(254).transform((v) => v.toLowerCase()),
  phone: z.string().trim().min(7).max(25),
  address: z.string().trim().min(10).max(500),
  paymentMethod: z.enum(["COD", "UPI"]),
  items: z.array(z.object({
    productId: idNumber, quantity: z.number().int().min(1).max(25),
    size: z.string().trim().min(1).max(30),
    color: z.string().max(40).optional().default("")
  }).strict()).min(1).max(30)
}).strict().superRefine((data, ctx) => {
  if (new Set(data.items.map((i) => `${i.productId}:${i.size}:${i.color}`)).size !== data.items.length) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "Remove duplicate items from your bag before checkout." });
  }
});
const createOrder = db.transaction((data) => {
  let subtotal = 0;
  const items = data.items.map(({ productId, quantity, size, color }) => {
    const p = db.prepare("SELECT * FROM products WHERE id=? AND status='Active'").get(productId);
    if (!p) throw fail(400, "One of the pieces in your bag is no longer available. Please refresh your bag.");
    if (p.stock < quantity) throw fail(409, `${p.name} has only ${p.stock} piece${p.stock === 1 ? "" : "s"} left.`);
    if (!JSON.parse(p.sizes_json).includes(size)) throw fail(400, `That size is no longer available for ${p.name}.`);
    if (JSON.parse(p.colors_json).length && !JSON.parse(p.colors_json).includes(color)) throw fail(400, `That colour is no longer available for ${p.name}.`);
    const unitPrice = p.discount_paise ?? p.price_paise;
    subtotal += unitPrice * quantity;
    return { product: p, quantity, unitPrice, size, color };
  });
  const quantitiesByProduct = new Map();
  for (const item of items) quantitiesByProduct.set(item.product.id, (quantitiesByProduct.get(item.product.id)||0)+item.quantity);
  for (const [productId,quantity] of quantitiesByProduct) {
    const p=db.prepare("SELECT name,stock FROM products WHERE id=?").get(productId);
    if(p.stock<quantity)throw fail(409,`${p.name} has only ${p.stock} piece${p.stock===1?"":"s"} left across its selected sizes.`);
  }
  const shipping = subtotal >= 299900 ? 0 : (subtotal ? 9900 : 0);
  const now = new Date();
  const id = `SR-${now.toISOString().slice(2, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  db.prepare(`INSERT INTO orders (id,customer_name,email,phone,address,payment_method,payment_status,status,subtotal_paise,shipping_paise,discount_paise,total_paise,created_at) VALUES (?,?,?,?,?,?,?,'Pending',?,?,?,?,?)`)
    .run(id,data.customerName,data.email,data.phone,data.address,data.paymentMethod,"Unpaid",subtotal,shipping,0,subtotal+shipping,now.toISOString());
  const insert = db.prepare("INSERT INTO order_items (order_id,product_id,sku,name,size,color,quantity,unit_price_paise,unit_cost_paise) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const item of items) insert.run(id,item.product.id,item.product.sku,item.product.name,item.size,item.color,item.quantity,item.unitPrice,item.product.cost_paise);
  return db.prepare("SELECT * FROM orders WHERE id=?").get(id);
});
app.post("/api/orders", (req, res, next) => {
  try {
    const data = validate(createOrderBody, req.body);
    res.status(201).json({ order: customerOrderConfirmation(createOrder(data)), message: "Order placed and awaiting owner confirmation." });
  } catch (error) { next(error); }
});

app.get("/api/admin/overview", requireOwner, requirePermission("reports.read"), (req, res) => {
  const range = Math.min(Math.max(Number(req.query.days) || 30, 1), 366);
  const since = new Date(Date.now() - range * 86400000).toISOString();
  const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
  const sales = db.prepare(`
    SELECT COALESCE(SUM(total_paise),0) revenue, COUNT(*) orders
    FROM orders WHERE status='Delivered' AND created_at>=?
  `).get(since);
  const cogs = db.prepare(`
    SELECT COALESCE(SUM(oi.unit_cost_paise * oi.quantity),0) AS total
    FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE o.status='Delivered' AND o.created_at>=?
  `).get(since).total;
  const expenses = db.prepare("SELECT COALESCE(SUM(amount_paise),0) total FROM expenses WHERE date>=?").get(since.slice(0, 10)).total;
  const inventory = db.prepare("SELECT COALESCE(SUM(stock * cost_paise),0) total, COUNT(*) products, COALESCE(SUM(stock),0) units, SUM(stock<=min_stock AND stock>0) low FROM products WHERE status!='Draft'").get();
  const orders = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status IN ('Pending','Confirmed','Processing','Shipped')").get().count;
  const delivered = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status='Delivered' AND created_at>=?").get(since).count;
  const today = new Date().toISOString().slice(0, 10);
  const todaySales = db.prepare("SELECT COALESCE(SUM(total_paise),0) total FROM orders WHERE status='Delivered' AND substr(created_at,1,10)=?").get(today).total;
  const monthSales = db.prepare("SELECT COALESCE(SUM(total_paise),0) total FROM orders WHERE status='Delivered' AND substr(created_at,1,10)>=?").get(monthStart).total;
  res.json({
    periodDays: range, salesToday: paiseToRupees(todaySales), salesThisMonth: paiseToRupees(monthSales), revenue: paiseToRupees(sales.revenue),
    purchaseCost: paiseToRupees(cogs), grossProfit: paiseToRupees(sales.revenue-cogs),
    expenses: paiseToRupees(expenses), netProfit: paiseToRupees(sales.revenue-cogs-expenses),
    unitsSold: db.prepare("SELECT COALESCE(SUM(oi.quantity),0) total FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status='Delivered' AND o.created_at>=?").get(since).total,
    inventoryValue: paiseToRupees(inventory.total), products: inventory.products, stockUnits: inventory.units,
    lowStock: inventory.low||0, pendingOrders: orders, deliveredOrders: delivered,
    openOrders: db.prepare("SELECT COUNT(*) total FROM orders WHERE status='Pending'").get().total,
    completedOrders: db.prepare("SELECT COUNT(*) total FROM orders WHERE status='Delivered'").get().total
  });
});

app.get("/api/admin/products", requireOwner, requirePermission("products.read"), (req, res) => {
  res.json({ products: ownerProductQuery().map((p) => ({ ...publicProduct(p), status: p.status })) });
});
const productInput = z.object({
  name:z.string().trim().min(1).max(120), sku:z.string().trim().min(1).max(40),
  category:z.enum(["Men","Women","Accessories"]), description:z.string().max(2000).optional().default(""),
  image:z.string().max(1000).optional().default(""), cost:money, price:money,
  discountPrice:money.nullable().optional(), stock:z.number().int().min(0).max(100000),
  minStock:z.number().int().min(0).max(100000).optional().default(5),
  sizes:z.array(z.string().trim().min(1).max(30)).min(1).max(8).optional().default(["S","M","L","XL"]),
  supplier:z.string().max(200).optional().default(""),   colors:z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/,"Use a six-digit hex colour, such as #b1a38e.")).max(12).optional().default([]),
  status:z.enum(["Active","Draft","Out of Stock"]).optional().default("Active")
}).strict();
function saveProduct(p, existingId = null) {
  const now=new Date().toISOString(),cost=moneyToPaise(p.cost),price=moneyToPaise(p.price),discount=p.discountPrice==null?null:moneyToPaise(p.discountPrice);
  const sizes=p.category==="Accessories"?["One size"]:p.sizes;
  if(discount!==null&&discount>price)throw fail(400,"A discount price cannot be higher than the regular selling price.");
  const status=p.status==="Draft"?"Draft":p.stock===0?"Out of Stock":"Active";
  if(existingId){
    const current=db.prepare("SELECT * FROM products WHERE id=?").get(existingId);
    if(!current)throw fail(404,"This product could not be found.");
    const change=p.stock-current.stock;
    db.prepare(`UPDATE products SET sku=?,name=?,category=?,description=?,image=?,cost_paise=?,price_paise=?,discount_paise=?,stock=?,min_stock=?,supplier=?,status=?,colors_json=?,sizes_json=?,updated_at=? WHERE id=?`)
      .run(p.sku,p.name,p.category,p.description,p.image,cost,price,discount,p.stock,p.minStock,p.supplier,status,JSON.stringify(p.colors),JSON.stringify(sizes),now,existingId);
    if(change)db.prepare("INSERT INTO stock_movements (product_id,sku,change_quantity,reason,created_at) VALUES (?,?,?,?,?)")
      .run(existingId,p.sku,change,"Manual stock adjustment",now);
    return db.prepare("SELECT * FROM products WHERE id=?").get(existingId);
  }
  const result=db.prepare(`INSERT INTO products (sku,name,category,description,image,cost_paise,price_paise,discount_paise,stock,min_stock,supplier,status,colors_json,sizes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.sku,p.name,p.category,p.description,p.image,cost,price,discount,p.stock,p.minStock,p.supplier,status,JSON.stringify(p.colors),JSON.stringify(sizes),now,now);
  if(p.stock)db.prepare("INSERT INTO stock_movements (product_id,sku,change_quantity,reason,created_at) VALUES (?,?,?,?,?)").run(result.lastInsertRowid,p.sku,p.stock,"Initial stock receipt",now);
  return db.prepare("SELECT * FROM products WHERE id=?").get(result.lastInsertRowid);
}
app.post("/api/admin/products", requireOwner, requirePermission("products.write"), (req,res,next)=>{try{const p=validate(productInput,req.body);res.status(201).json({product:publicProduct(saveProduct(p))});}catch(e){next(e);}});
app.patch("/api/admin/products/:id", requireOwner, requirePermission("products.write"), (req,res,next)=>{try{const p=validate(productInput.partial().strict(),req.body);const current=db.prepare("SELECT * FROM products WHERE id=?").get(idNumber.parse(req.params.id));if(!current)throw fail(404,"This product could not be found.");const merged={name:current.name,sku:current.sku,category:current.category,description:current.description,image:current.image,cost:paiseToRupees(current.cost_paise),price:paiseToRupees(current.price_paise),discountPrice:current.discount_paise===null?null:paiseToRupees(current.discount_paise),stock:current.stock,minStock:current.min_stock,supplier:current.supplier,status:current.status,colors:JSON.parse(current.colors_json),sizes:JSON.parse(current.sizes_json),...p};res.json({product:publicProduct(saveProduct(merged,current.id))});}catch(e){next(e);}});

app.get("/api/admin/orders",requireOwner,requirePermission("orders.read"),(req,res)=>res.json({orders:db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 500").all().map(row=>presentAdminOrder(row,req.admin.role))}));
const changeOrder = db.transaction((id,status,restock=false)=>{
  const order=db.prepare("SELECT * FROM orders WHERE id=?").get(id);
  if(!order)throw fail(404,"This order could not be found.");
  if(order.status===status)return order;
  const transitions = {
    Pending: ["Confirmed", "Cancelled"],
    Confirmed: ["Processing", "Cancelled"],
    Processing: ["Shipped", "Cancelled"],
    Shipped: ["Delivered"],
    Delivered: ["Refunded"],
    Cancelled: [],
    Refunded: []
  };
  if (!transitions[order.status]?.includes(status)) throw fail(409,`An order cannot move from ${order.status} to ${status}.`);
  const items=db.prepare("SELECT * FROM order_items WHERE order_id=?").all(id);
  const now=new Date().toISOString();
  if(status==="Confirmed"&&!order.reserved){
    for(const item of items){const p=db.prepare("SELECT stock FROM products WHERE id=?").get(item.product_id);if(!p||p.stock<item.quantity)throw fail(409,`There is not enough stock for ${item.name}. Adjust inventory before confirming.`);}
    for(const item of items){db.prepare("UPDATE products SET stock=stock-?,updated_at=? WHERE id=?").run(item.quantity,now,item.product_id);db.prepare("INSERT INTO stock_movements (product_id,sku,change_quantity,reason,reference,created_at) VALUES (?,?,?,?,?,?)").run(item.product_id,item.sku,-item.quantity,"Order stock reservation",id,now);}
  }
  if(status==="Cancelled"&&order.reserved){for(const item of items){db.prepare("UPDATE products SET stock=stock+?,updated_at=? WHERE id=?").run(item.quantity,now,item.product_id);db.prepare("INSERT INTO stock_movements (product_id,sku,change_quantity,reason,reference,created_at) VALUES (?,?,?,?,?,?)").run(item.product_id,item.sku,item.quantity,"Cancelled order stock returned",id,now);}}
  if(status==="Refunded"){
    db.prepare("UPDATE orders SET payment_status='Refunded' WHERE id=?").run(id);
    if(restock){
      for(const item of items){
        db.prepare("UPDATE products SET stock=stock+?,updated_at=? WHERE id=?").run(item.quantity,now,item.product_id);
        db.prepare("INSERT INTO stock_movements (product_id,sku,change_quantity,reason,reference,created_at) VALUES (?,?,?,?,?,?)").run(item.product_id,item.sku,item.quantity,"Refunded order returned to stock",id,now);
      }
    }
  }
  const reserved = ["Confirmed","Processing","Shipped","Delivered"].includes(status)
    ? (order.reserved || status === "Confirmed" ? 1 : 0)
    : 0;
  db.prepare("UPDATE orders SET status=?,reserved=? WHERE id=?").run(status,reserved,id);
  return db.prepare("SELECT * FROM orders WHERE id=?").get(id);
});
app.patch("/api/admin/orders/:id",requireOwner,requirePermission("orders.update"),(req,res,next)=>{try{const {status,restock}=validate(z.object({status:z.enum(orderStatuses),restock:z.boolean().optional().default(false)}).strict(),req.body);if(restock&&status!=="Refunded")throw fail(400,"Only refunded orders can be returned to inventory.");res.json({order:presentAdminOrder(changeOrder(req.params.id,status,restock),req.admin.role)});}catch(e){next(e);}});

app.get("/api/admin/expenses",requireOwner,requirePermission("expenses.read"),(req,res)=>{const rows=db.prepare("SELECT * FROM expenses ORDER BY date DESC,id DESC LIMIT 500").all().map(r=>({id:r.id,category:r.category,amount:paiseToRupees(r.amount_paise),description:r.description,reference:r.reference,date:r.date}));res.json({expenses:rows});});
const expenseInput=z.object({category:z.enum(["Rent","Salaries","Advertising","Packaging","Shipping","Utilities","Payment fees","Website","Miscellaneous"]),amount:z.number().finite().positive().max(100000000),description:z.string().trim().min(1).max(300),reference:z.string().max(120).optional().default(""),date:isoDate}).strict();
app.post("/api/admin/expenses",requireOwner,requirePermission("expenses.write"),(req,res,next)=>{try{const x=validate(expenseInput,req.body);const result=db.prepare("INSERT INTO expenses (category,amount_paise,description,reference,date,created_at) VALUES (?,?,?,?,?,?)").run(x.category,moneyToPaise(x.amount),x.description,x.reference,x.date,new Date().toISOString());res.status(201).json({expense:{id:result.lastInsertRowid,...x}});}catch(e){next(e);}});
app.get("/api/admin/stock-movements",requireOwner,requirePermission("inventory.read"),(req,res)=>{const movements=db.prepare("SELECT id,product_id AS productId,sku,change_quantity AS changeQuantity,reason,reference,created_at AS createdAt FROM stock_movements ORDER BY created_at DESC LIMIT 500").all();res.json({movements});});

app.get("/api/admin/users", requireOwner, requirePermission("admins.read"), (req, res) => {
  const users = db.prepare("SELECT id,email,role,is_active AS active,mfa_enabled AS mfaEnabled,created_at AS createdAt FROM users ORDER BY id").all();
  res.json({ users });
});
app.post("/api/admin/invitations", requireOwner, requireSuperAdmin, (req, res, next) => {
  try {
    const data = validate(z.object({
      email: z.string().email().max(254).transform((value) => value.toLowerCase()),
      role: z.enum(["admin", "staff"])
    }).strict(), req.body);
    if (db.prepare("SELECT 1 FROM users WHERE email=?").get(data.email)) throw fail(409, "An account already exists for that email.");
    const token = crypto.randomBytes(32).toString("hex");
    const id = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`INSERT INTO admin_invitations
      (id,email,role,token_hash,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, data.email, data.role, sha256(token), expiresAt, req.admin.id, now.toISOString());
    res.status(201).json({ invitation: { email: data.email, role: data.role, expiresAt, url: `/admin/invite?token=${token}` } });
  } catch (error) { next(error); }
});
app.patch("/api/admin/users/:id", requireOwner, requireSuperAdmin, (req, res, next) => {
  try {
    const id = idNumber.parse(req.params.id);
    const input = validate(z.object({
      role: z.enum(["super_admin", "admin", "staff"]).optional(),
      active: z.boolean().optional()
    }).strict().refine((value) => Object.keys(value).length > 0), req.body);
    if (id === req.admin.id && (input.active === false || (input.role && input.role !== "super_admin"))) {
      throw fail(400, "You cannot disable or demote your own Super Admin account.");
    }
    const user = db.prepare("SELECT id,role,is_active FROM users WHERE id=?").get(id);
    if (!user) throw fail(404, "This account could not be found.");
    if (user.role === "super_admin" && user.is_active &&
        (input.role && input.role !== "super_admin" || input.active === false)) {
      const otherSuperAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='super_admin' AND is_active=1 AND id!=?")
        .get(id).count;
      if (!otherSuperAdmins) throw fail(409, "At least one active Super Admin account must remain.");
    }
    const updated = db.prepare("UPDATE users SET role=COALESCE(?,role),is_active=COALESCE(?,is_active) WHERE id=?")
      .run(input.role || null, input.active === undefined ? null : Number(input.active), id);
    if (input.active === false) db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    res.json({ updated: updated.changes === 1 });
  } catch (error) { next(error); }
});

app.get("/admin", (req, res) => {
  if (!adminIpAllowed(req)) return hidden(res);
  const session = getSession(req);
  if (!sessionValid(session) || !session.mfa_enabled || !session.mfa_verified ||
      !["super_admin", "admin", "staff"].includes(session.role)) return hidden(res);
  res.set("Cache-Control", "no-store").sendFile(require("node:path").join(ADMIN_DIR, "index.html"));
});
app.get("/admin/login", (req, res) => {
  if (!adminIpAllowed(req)) return hidden(res);
  const session = getSession(req);
  if (sessionValid(session)) {
    return res.redirect(session.mfa_enabled && session.mfa_verified ? "/admin" : "/admin/mfa-setup");
  }
  res.set("Cache-Control", "no-store").sendFile(require("node:path").join(ADMIN_DIR, "login.html"));
});
app.get("/admin/mfa-setup", (req, res) => {
  if (!adminIpAllowed(req)) return hidden(res);
  const session = getSession(req);
  if (!sessionValid(session) || session.mfa_enabled || session.mfa_verified) return hidden(res);
  res.set("Cache-Control", "no-store").sendFile(require("node:path").join(ADMIN_DIR, "mfa-setup.html"));
});
app.get("/admin/invite", (req, res) => {
  if (!adminIpAllowed(req)) return hidden(res);
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
    .sendFile(require("node:path").join(ADMIN_DIR, "invite.html"));
});

app.use(express.static(require("node:path").join(__dirname,"public"),{index:"index.html",etag:true,maxAge:process.env.NODE_ENV==="production"?"1h":0}));
app.get("/admin/*path", (req, res) => hidden(res));
app.use("/api",(req,res)=>res.status(404).json({error:"This store service does not have that endpoint."}));
app.use((req,res)=>res.status(404).send("Not found"));
app.use((error,req,res,next)=>{if(res.headersSent)return next(error);if(error.code==="SQLITE_CONSTRAINT_UNIQUE")return res.status(409).json({error:"That SKU or email is already in use."});if(error.code==="SQLITE_CONSTRAINT_CHECK")return res.status(400).json({error:"That value is outside the permitted range."});if(error instanceof SyntaxError&&"body" in error)return res.status(400).json({error:"Please send valid JSON."});if(error.name==="ZodError")return res.status(400).json({error:error.issues.map(i=>i.message).join("; ")});const status=Number.isInteger(error.status)?error.status:500;if(status>=500)console.error("SR CLOTHING request failed:",error);res.status(status).json({error:status>=500?"Something went wrong. Please try again.":error.message});});

const port=Number(process.env.PORT)||3000;
if(require.main===module){app.listen(port,()=>console.log(`SR CLOTHING is ready at http://localhost:${port} · database: ${process.env.DB_PATH||"./data/sr-clothing.sqlite"}`));}
module.exports={app,db};
