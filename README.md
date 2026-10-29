# SR CLOTHING

A responsive independent-fashion storefront and a SQLite-backed Node.js API. A standalone administration panel is served only by the Express application at `/admin`; its HTML is stored outside the public web root and connects to the existing protected business APIs. The static storefront contains no dashboard or public admin-registration page.

## Run on a computer with Node.js 20+

```powershell
npm install
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# Put the generated value in .env as ADMIN_MFA_ENCRYPTION_KEY.
npm run create-owner
npm start
```

Open http://localhost:3000 for the storefront; use the Express app server rather than VS Code Live Server so product changes and uploads use the same API and database as Admin. Use **Staff sign in** in the footer to open `/admin/login`; the panel still requires an invited account, password, and authenticator code. In Admin, choose a JPEG, PNG, or WebP product image up to 5 MB from your device; uploaded images are stored in the configured database. The first Super Admin is created by the CLI and must enroll an authenticator before entering the panel. Keep `ADMIN_MFA_ENCRYPTION_KEY` private, stable, and separately backed up: losing it prevents decrypting enrolled MFA secrets. Set the exact trusted `APP_ORIGIN`; keep the SQLite database and `.env` private, and serve production behind HTTPS. Admin sessions expire after 20 minutes idle or 8 hours absolute.

To change the single active Super Admin's email and password, run `npm run change-owner -- your-new-admin@example.com` in an interactive terminal on the machine hosting the database (or the Render Shell for a deployed database). Enter and confirm the new password at the hidden prompts; do not pass it as a command argument or share it in chat. The operation retains the existing authenticator enrollment and signs out all current sessions. Sign in again with the new email, password, and existing authenticator code.

## Publish a public preview on GitHub Pages

The GitHub Actions workflow in `.github/workflows/deploy-pages.yml` automatically publishes the static files in `public/` to GitHub Pages whenever a commit is pushed to `main`. The preview URL for this repository is https://dhavancroma-del.github.io/SR-Clothing-Store-/; the first deployment can take a few minutes. Check the repository's **Actions** tab for the deployment status.

GitHub Pages only hosts static files. It does **not** run the Node.js API, accept real orders, save owner changes, or serve the admin panel. Use the Render deployment below for the full application with persistent storage. Do not accept real orders through the static preview.

## Publish the full store and admin panel on Vercel

Vercel runs the Express API and guarded `/admin` pages as a Node.js Function. The customer-facing files remain static, while the database is stored in Turso because a Vercel Function cannot persist a local SQLite file between requests.

1. Create a Turso database and an authentication token. Keep the token private.
2. Import this repository into Vercel and deploy it with the repository root as the project root.
3. Add these Vercel environment variables for Production and Preview:
   - `TURSO_DATABASE_URL` — the database's `libsql://...` URL.
   - `TURSO_AUTH_TOKEN` — the Turso token for that database.
   - `ADMIN_MFA_ENCRYPTION_KEY` — a private, stable, 64-character hexadecimal key. Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and back it up securely.
4. By default, the app uses Vercel's deployment URL as its exact trusted origin, including for preview deployments. If Production uses a custom domain, set `APP_ORIGIN` to that exact HTTPS origin (for example `https://shop.example.com`) in the **Production** environment only. Leave it unset for Preview so each preview uses its own Vercel URL.
5. From a trusted local terminal, configure `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and the same `ADMIN_MFA_ENCRYPTION_KEY` in `.env`, then run `npm run create-owner`. This provisions the initial Super Admin directly in Turso; there is no public registration or owner-creation endpoint. Keep `.env` out of Git.
6. Open `/admin/login` on the deployed site and enroll an authenticator on first sign-in. Test storefront, login, and an admin-managed catalog update before using the store with customers.

The function initializes the Turso schema on first use and applies additive migrations. Vercel deployments require the Turso variables; they will not silently fall back to ephemeral SQLite. `npm run change-owner -- your-new-admin@example.com` can update the owner from a trusted local terminal using the same Turso credentials; enter the replacement password only at the hidden prompt. Existing sessions are revoked, and the current MFA enrollment is retained.

The database and application must use a stable `ADMIN_MFA_ENCRYPTION_KEY`; changing or losing it prevents decrypting enrolled MFA secrets. Use Vercel's separate Production and Preview environment scopes, and never put database tokens or owner passwords in source control. For an SQLite-based full deployment, use the Render option below instead.

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
