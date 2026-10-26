# SR CLOTHING

A responsive independent-fashion storefront, an owner-only business studio, and a SQLite-backed Node.js API. The shop and dashboard can be previewed as a labelled, temporary sample without a server. Real owner accounts, catalog edits, stock, orders, expenses and reports are served and stored on the application server.

## Run on a computer with Node.js 20+

```powershell
npm install
Copy-Item .env.example .env
npm run create-owner
npm start
```

Open http://localhost:3000. Configure `.env` with your private production `APP_ORIGIN` and a durable, private `DB_PATH` before deployment. Keep `.env`, the SQLite database, customer addresses, and session data out of version control and public web folders. Protect and back up the database. Place the production app behind HTTPS; the owner session cookie is `Secure` in production.

## Publish on Render

This project includes a Render Blueprint (`render.yaml`) that creates a Node.js web service and mounts a persistent disk for the private SQLite database. To publish it:

1. Push this project to a GitHub repository you control. Keep `.env`, database files, and owner credentials private and out of Git.
2. In Render, choose **New + → Blueprint**, connect the repository, and deploy the `render.yaml` Blueprint. Render provides an HTTPS URL; the app uses Render's URL for same-origin API checks unless you set `APP_ORIGIN` to a custom domain.
3. After the service is live, open its Render Shell and run `npm run create-owner` once. Enter the owner email and a unique password of at least 12 characters. Do not put the password in source code, GitHub, or environment settings.
4. Open the service's HTTPS URL to check the storefront and sign in to the owner studio. Configure a custom domain through Render if desired, and set `APP_ORIGIN` to that exact HTTPS origin.

The Render disk is required: without persistent storage, SQLite data would be lost when the service restarts or is redeployed. The storefront can accept orders, but payment collection and other external integrations are not configured; follow the guidance below before accepting real orders.

To change the owner login, remove the existing `data/sr-clothing.sqlite` **only after a backup** and create the owner again, or implement a verified owner password-change procedure. Owner signup and public account creation are intentionally disabled. `npm test` checks that public product responses protect purchase costs, variants are validated server-side, reserved inventory is restored on cancellation, refunds and stock returns are recorded correctly, and delivered sales, cost of goods, expenses, and profit-and-loss totals reconcile.

## Financial accounting

Amounts entered as rupees are validated by the server and persisted as integer paise. An order stores a snapshot of each item’s SKU, size, colour, discounted selling price and purchase cost, so subsequent catalog edits cannot change historic margins. Stock is tracked at product level; the server checks aggregate quantities across all selected variants before accepting or confirming an order. Only delivered orders count as revenue. Gross profit is delivered-order revenue less their recorded cost of goods sold; net profit is gross profit less dated operating expenses. Current stock value is on-hand units multiplied by current cost. Purchase cost is **not** also recorded as an operating expense. Cancelling a stock-reserved order returns inventory and makes the order ineligible for recognized revenue. Refunding a delivered order reverses its recorded revenue and COGS; returned stock is restored only when the owner explicitly selects that option. Gateway fees, tax and other return-related adjustments require explicit accounting entries; estimates and unconfigured gateway charges are never silently invented.

Orders start as unpaid and pending. Admin confirmation reserves inventory, and deliveries are recognized only after marking an order delivered. The checkout states whether payment is unpaid; it never collects or stores card details. Shipping for real orders is a currently configured ₹99 below the complimentary ₹2,999 threshold. Configure and validate shipping, tax, refund and return policies for the business before accepting real orders.

## Security and external integrations

Passwords are scrypt-hashed with per-account random salts and the provisioning CLI conceals password input. Owner access uses expiring, server-side sessions; only the SHA-256 hash of the opaque session token is stored in SQLite. The owner cookie is HTTP-only and SameSite Strict. Mutating routes require the exact configured same-site origin. The login and checkout APIs are rate-limited, request bodies are size-limited, and administrator catalog, financial, order and stock history endpoints require the authenticated owner. Order transitions are validated server-side, delivered sales can only be refunded explicitly, and stock returns are opt-in and audited. Never enable broad cross-origin access to the API. Configure the trusted proxy only when the deployment platform requires it.

The public product catalog intentionally never returns supplier names, purchase prices, cost margins, or stock-alert thresholds. Configure a payment provider (such as Razorpay or Stripe), webhook signature verification, transactional email, shipping provider, tax rules, and production hosting separately before enabling them; none is represented as connected or paid when it is not. Do not enter real customer payment data into the sample preview. Images and typefaces use Unsplash and Google Fonts, respectively, and need an internet connection.

## Project

- `public/index.html`, `public/styles.css`, `public/app.js` — responsive storefront and dashboard.
- `server.js` — validated Node.js API, owner authentication, checkout and admin workflows.
- `src/database.js` — persistent SQLite schema, accounting snapshots and inventory audit log.
- `scripts/create-owner.js` — one-time, concealed-password owner provisioning; no default/demo password.
- `data/` — created at runtime for the private SQLite database.
