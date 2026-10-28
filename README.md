# SR CLOTHING

A responsive independent-fashion storefront and a SQLite-backed Node.js API. The administration panel is served only by the Express application at `/admin`; its HTML is stored outside the public web root. The static storefront contains no dashboard or public admin-registration page.

## Run on a computer with Node.js 20+

```powershell
npm install
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# Put the generated value in .env as ADMIN_MFA_ENCRYPTION_KEY.
npm run create-owner
npm start
```

Open http://localhost:3000 for the storefront. The admin sign-in entry is hidden behind five quick clicks on either SR logo; the panel still requires an invited account, password, and authenticator code. The first Super Admin is created by the CLI and must enroll an authenticator before entering the panel. Keep `ADMIN_MFA_ENCRYPTION_KEY` private, stable, and separately backed up: losing it prevents decrypting enrolled MFA secrets. Set the exact trusted `APP_ORIGIN`; keep the SQLite database and `.env` private, and serve production behind HTTPS. Admin sessions expire after 20 minutes idle or 8 hours absolute.

To change the single active Super Admin's email and password, run `npm run change-owner -- your-new-admin@example.com` in an interactive terminal on the machine hosting the database (or the Render Shell for a deployed database). Enter and confirm the new password at the hidden prompts; do not pass it as a command argument or share it in chat. The operation retains the existing authenticator enrollment and signs out all current sessions. Sign in again with the new email, password, and existing authenticator code.

## Publish a public preview on GitHub Pages

The GitHub Actions workflow in `.github/workflows/deploy-pages.yml` automatically publishes the static files in `public/` to GitHub Pages whenever a commit is pushed to `main`. The preview URL for this repository is https://dhavancroma-del.github.io/SR-Clothing-Store-/; the first deployment can take a few minutes. Check the repository's **Actions** tab for the deployment status.

GitHub Pages only hosts static files. It does **not** run the Node.js API, accept real orders, save owner changes, or serve the admin panel. Use the Render deployment below for the full application with persistent storage. Do not accept real orders through the static preview.

## Publish a static preview on Vercel

The `vercel.json` configuration publishes only the files in `public/`, so Vercel serves the storefront instead of trying to run the SQLite-backed Node.js server as a serverless function. Import this repository into Vercel and deploy the `main` branch, or push a new commit to trigger a deployment for an already connected project. This is a static preview: the live catalog API, checkout, and private admin panel require the full Render service described below.

## Publish on Render

This project includes a Render Blueprint (`render.yaml`) that creates a Node.js web service and mounts a persistent disk for the private SQLite database. To publish it:

1. Push this project to a GitHub repository you control. Keep `.env`, database files, and owner credentials private and out of Git.
2. In Render, choose **New + → Blueprint**, connect the repository, and deploy the `render.yaml` Blueprint. Render provides an HTTPS URL; the app uses Render's URL for same-origin API checks unless you set `APP_ORIGIN` to a custom domain.
3. Before starting the service, set a randomly generated 64-character hexadecimal `ADMIN_MFA_ENCRYPTION_KEY` in Render's environment. Keep it stable and backed up. Optionally set `ADMIN_IP_ALLOWLIST` to comma-separated trusted IP addresses or IPv4 CIDRs. If using the allowlist behind a proxy, configure `TRUST_PROXY` only for the known proxy hop count.
4. After the service is live, open its Render Shell and run `npm run create-owner` once. Enter the owner email and a unique 12–72 character password. Do not put the password in source code, GitHub, or environment settings.
5. Open `/admin/login` on the HTTPS service and enroll an authenticator on first sign-in. Invitations are created by the Super Admin through `POST /api/admin/invitations`; the returned one-time link expires after 24 hours. Deliver the link to the invited person through a trusted channel.

The Render disk is required: without persistent storage, SQLite data would be lost when the service restarts or is redeployed. The storefront can accept orders, but payment collection and other external integrations are not configured; follow the guidance below before accepting real orders.

Public admin registration is disabled. Staff accounts can only be created from a Super Admin invitation, must enroll MFA before panel access, and receive role-limited API permissions. Super Admins can invite Admin or Staff roles; Staff is limited to order support and cannot see purchase costs or issue refunds. `npm test` checks public panel privacy, MFA and invitation setup, CSRF/RBAC behavior, as well as storefront inventory and accounting flows.

## Financial accounting

Amounts entered as rupees are validated by the server and persisted as integer paise. An order stores a snapshot of each item’s SKU, size, colour, discounted selling price and purchase cost, so subsequent catalog edits cannot change historic margins. Stock is tracked at product level; the server checks aggregate quantities across all selected variants before accepting or confirming an order. Only delivered orders count as revenue. Gross profit is delivered-order revenue less their recorded cost of goods sold; net profit is gross profit less dated operating expenses. Current stock value is on-hand units multiplied by current cost. Purchase cost is **not** also recorded as an operating expense. Cancelling a stock-reserved order returns inventory and makes the order ineligible for recognized revenue. Refunding a delivered order reverses its recorded revenue and COGS; returned stock is restored only when the owner explicitly selects that option. Gateway fees, tax and other return-related adjustments require explicit accounting entries; estimates and unconfigured gateway charges are never silently invented.

Orders start as unpaid and pending. Admin confirmation reserves inventory, and deliveries are recognized only after marking an order delivered. The checkout states whether payment is unpaid; it never collects or stores card details, and cash on delivery is the only customer-facing payment option until a payment provider is configured. Shipping for real orders is a currently configured ₹99 below the complimentary ₹2,999 threshold. Configure and validate shipping, tax, refund and return policies for the business before accepting real orders. A shopper's bag and saved pieces persist in that browser and are reconciled against live stock when the catalog loads; clearing browser storage removes them.

## Security and external integrations

Passwords use bcrypt with a cost factor of 12; legacy scrypt passwords are upgraded at successful login. Admin login requires a time-based authenticator code once enrolled. MFA secrets are encrypted with AES-256-GCM using `ADMIN_MFA_ENCRYPTION_KEY`. Registration is closed; the CLI provisions only the initial Super Admin and Super Admin invitations are single-use and expire after 24 hours.

Admin sessions use random opaque tokens; SQLite stores only their SHA-256 hashes. Cookies are HTTP-only, SameSite Strict, and Secure in production. Sessions enforce both 20-minute inactivity and an 8-hour maximum lifetime. State-changing authenticated requests require a session-bound CSRF token and the exact configured same-site origin. Login and invitation acceptance are rate-limited, request bodies are size-limited, and admin API routes enforce RBAC server-side. The optional IP allowlist accepts individual addresses and IPv4 CIDRs; when operating behind a proxy, trust only the known proxy hops or the client IP allowlist can be spoofed. Never enable broad cross-origin access to the API.

The public product catalog intentionally never returns supplier names, purchase prices, cost margins, or stock-alert thresholds. Configure a payment provider (such as Razorpay or Stripe), webhook signature verification, transactional email, shipping provider, tax rules, and production hosting separately before enabling them; none is represented as connected or paid when it is not. Do not enter real customer payment data into the sample preview. Images and typefaces use Unsplash and Google Fonts, respectively, and need an internet connection.

## Project

- `public/index.html`, `public/styles.css`, `public/app.js` — public storefront.
- `private-admin/` — admin page and authentication screens, served through guarded Express routes only.
- `server.js` — validated Node.js API, authentication, MFA, RBAC, checkout and admin workflows.
- `src/admin-security.js` — bcrypt, TOTP, MFA secret encryption, and IP matching.
- `src/database.js` — persistent SQLite schema, accounting snapshots and inventory audit log.
- `scripts/create-owner.js` — one-time, concealed-password Super Admin provisioning; no default password.
- `data/` — created at runtime for the private SQLite database.
