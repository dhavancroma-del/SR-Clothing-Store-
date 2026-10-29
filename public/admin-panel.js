"use strict";

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const content = $("#panel-content");
  const dialog = $("#form-dialog");
  const dialogForm = $("#dialog-form");
  const state = { user: null, csrfToken: "", panel: "overview", loadRequestId: 0, products: [], orders: [], expenses: [], users: [], overview: null, range: 30 };
  const panelInfo = {
    overview: ["Overview", "YOUR BUSINESS AT A GLANCE", "Welcome to your studio", "A clear view of what is happening across your store."],
    products: ["Products", "CATALOG MANAGEMENT", "Your collection", "Manage product details, pricing, and availability."],
    inventory: ["Inventory", "STOCK MANAGEMENT", "Stock, at a glance", "Keep an eye on available pieces and recent stock movements."],
    orders: ["Orders", "CUSTOMER ORDERS", "Orders to take care of", "Review customer orders and keep each one moving."],
    expenses: ["Expenses", "BUSINESS COSTS", "Every rupee, accounted for", "Record the operating costs behind your business."],
    reports: ["Reports", "BUSINESS PERFORMANCE", "The bigger picture", "Understand sales, stock, and profit over time."],
    team: ["Team", "PEOPLE & ACCESS", "Your team", "Manage who can access your business workspace."]
  };
  const panelPermissions = {
    super_admin: ["overview", "products", "inventory", "orders", "expenses", "reports", "team"],
    admin: ["overview", "products", "inventory", "orders", "expenses", "reports", "team"],
    staff: ["orders"]
  };
  const money = (value) => new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR", maximumFractionDigits: 0
  }).format(Number(value) || 0);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const date = (value) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(parsed);
  };
  const statusClass = (value) => String(value || "").toLowerCase().replace(/[^a-z_]/g, "");

  function notice(message, isError = false) {
    const element = $("#notice");
    element.textContent = message;
    element.classList.toggle("error", isError);
    element.hidden = false;
  }

  function clearNotice() {
    const element = $("#notice");
    element.textContent = "";
    element.classList.remove("error");
    element.hidden = true;
  }

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body) headers["Content-Type"] = "application/json";
    if (options.method && options.method !== "GET" && options.method !== "HEAD") {
      headers["X-CSRF-Token"] = state.csrfToken;
    }
    const response = await fetch(`/api${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers
    });
    if (response.status === 204) return null;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  function allowedPanels() {
    return panelPermissions[state.user?.role] || [];
  }

  function configureUser() {
    $("#account-email").textContent = state.user.email;
    $("#account-role").textContent = state.user.role.replace("_", " ");
    $("#account-avatar").textContent = state.user.email.slice(0, 1).toUpperCase();
    $$(".nav-item").forEach((item) => {
      item.hidden = !allowedPanels().includes(item.dataset.panel);
    });
  }

  function setHeading(panel) {
    const [label, overline, title, description] = panelInfo[panel];
    $("#page-label").textContent = label;
    $("#page-overline").textContent = overline;
    $("#page-title").textContent = title;
    $("#page-description").textContent = description;
    $("#heading-actions").replaceChildren();
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.panel === panel));
  }

  function stat(label, value, footnote, accent = false) {
    return `<article class="card stat-card"><span class="stat-label">${escapeHtml(label)}</span><strong class="stat-value${accent ? " stat-accent" : ""}">${escapeHtml(value)}</strong><span class="stat-foot">${escapeHtml(footnote)}</span></article>`;
  }

  function orderRows(orders, includeActions = true) {
    if (!orders.length) return `<tr><td colspan="6"><div class="empty-state">No orders to show yet.</div></td></tr>`;
    return orders.map((order) => {
      const items = (order.items || []).map((item) => `${item.name} × ${item.quantity}`).join(", ") || "Order items";
      const status = String(order.status || "").toLowerCase();
      const availableStatuses = state.user.role === "staff"
        ? ["Confirmed", "Processing", "Shipped", "Delivered", "Cancelled"]
        : ["Confirmed", "Processing", "Shipped", "Delivered", "Cancelled", "Refunded"];
      const currentStatusAvailable = availableStatuses.some((item) => item.toLowerCase() === status);
      const currentStatusOption = currentStatusAvailable
        ? ""
        : `<option value="" selected disabled>${escapeHtml(order.status)} · choose a new status</option>`;
      const action = includeActions
        ? `<div class="table-actions"><select class="inline-control" aria-label="Update status for order ${escapeHtml(order.id)}" data-order-status="${escapeHtml(order.id)}">${currentStatusOption}${availableStatuses.map((item) => `<option value="${item}" ${status === item.toLowerCase() ? "selected" : ""}>${item}</option>`).join("")}</select><button class="button small" type="button" data-save-order="${escapeHtml(order.id)}" ${currentStatusAvailable ? "" : "disabled"}>Save</button></div>${state.user.role === "staff" ? "" : `<label class="checkbox-row restock-control" hidden data-restock-for="${escapeHtml(order.id)}"><input type="checkbox" data-restock="${escapeHtml(order.id)}"> Return items to stock</label>`}`
        : "";
      return `<tr><td><strong>${escapeHtml(order.id)}</strong><span class="sub-cell">${escapeHtml(date(order.createdAt))}</span></td><td><strong>${escapeHtml(order.customerName || "Customer")}</strong><span class="sub-cell">${escapeHtml(order.email || "")}</span></td><td>${escapeHtml(items)}</td><td><span class="status ${statusClass(order.status)}">${escapeHtml(order.status)}</span></td><td><strong>${money(order.total)}</strong></td><td>${action || "—"}</td></tr>`;
    }).join("");
  }

  function orderTable(orders, includeActions = true) {
    return `<div class="card table-card"><div class="table-wrap"><table><thead><tr><th>ORDER</th><th>CUSTOMER</th><th>ITEMS</th><th>STATUS</th><th>TOTAL</th><th>${includeActions ? "ACTION" : ""}</th></tr></thead><tbody>${orderRows(orders, includeActions)}</tbody></table></div></div>`;
  }

  function renderOverview() {
    const overview = state.overview;
    const recent = state.orders.slice(0, 5);
    content.innerHTML = `<div class="stats-grid">
      ${stat("Sales today", money(overview.salesToday), "Delivered orders")}
      ${stat("Sales this month", money(overview.salesThisMonth), `${overview.periodDays}-day reporting window`)}
      ${stat("Net profit", money(overview.netProfit), "After recorded expenses", true)}
      ${stat("Open orders", overview.openOrders, `${overview.pendingOrders} awaiting fulfilment`)}
      ${stat("Products", overview.products, "In your catalog")}
      ${stat("Units in stock", overview.stockUnits, `${overview.lowStock} running low`)}
      ${stat("Inventory value", money(overview.inventoryValue), "At current purchase cost")}
      ${stat("Units sold", overview.unitsSold, "Delivered in reporting period")}
    </div>
    <div class="dashboard-grid">
      <section class="card"><div class="card-heading"><div><h2>Recent orders</h2><p>Your latest customer activity</p></div><button class="button secondary small" type="button" data-go="orders">All orders</button></div>${recent.length ? `<div class="quick-list">${recent.map((order) => `<div class="quick-row"><span><strong>${escapeHtml(order.customerName || "Customer")}</strong><small>${escapeHtml(order.id)} · ${escapeHtml(date(order.createdAt))}</small></span><span class="quick-value"><strong>${money(order.total)}</strong><small class="status ${statusClass(order.status)}">${escapeHtml(order.status)}</small></span></div>`).join("")}</div>` : `<div class="empty-state">Your first order will appear here.</div>`}</section>
      <section class="card"><div class="card-heading"><div><h2>Quick actions</h2><p>Get straight to the work</p></div></div><div class="shortcuts">
        <button class="shortcut" type="button" data-action="add-product"><span><strong>Add a product</strong><small>Bring a new piece to your collection</small></span><span class="shortcut-arrow">＋</span></button>
        <button class="shortcut" type="button" data-go="inventory"><span><strong>Check your stock</strong><small>${escapeHtml(overview.lowStock)} item${overview.lowStock === 1 ? "" : "s"} need attention</small></span><span class="shortcut-arrow">→</span></button>
        <button class="shortcut" type="button" data-action="add-expense"><span><strong>Record an expense</strong><small>Keep your books up to date</small></span><span class="shortcut-arrow">＋</span></button>
      </div></section>
    </div>`;
  }

  function renderProducts() {
    const query = ($("#product-search")?.value || "").trim().toLowerCase();
    const products = state.products.filter((product) => `${product.name} ${product.sku} ${product.category}`.toLowerCase().includes(query));
    $("#heading-actions").innerHTML = `<button class="button secondary" type="button" data-action="export-products">Export CSV</button><button class="button" type="button" data-action="add-product">＋ Add product</button>`;
    content.innerHTML = `<section class="card table-card"><div class="table-toolbar"><div><strong>Products</strong><span class="sub-cell">${products.length} item${products.length === 1 ? "" : "s"} in this view</span></div><input class="search-input" id="product-search" type="search" placeholder="Search products or SKU" value="${escapeHtml(query)}" aria-label="Search products"></div><div class="table-wrap"><table><thead><tr><th>PRODUCT</th><th>SKU</th><th>CATEGORY</th><th>PRICE</th><th>COST</th><th>STOCK</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>${products.length ? products.map((product) => `<tr><td><strong>${escapeHtml(product.name)}</strong><span class="sub-cell">${escapeHtml(product.description || "")}</span></td><td>${escapeHtml(product.sku)}</td><td>${escapeHtml(product.category)}</td><td>${money(product.discountPrice ?? product.price)}</td><td>${money(product.cost)}</td><td>${escapeHtml(product.stock)}<span class="sub-cell">Low at ${escapeHtml(product.minStock)}</span></td><td><span class="status ${statusClass(product.status)}">${escapeHtml(product.status)}</span></td><td><div class="table-actions"><button class="button secondary small" type="button" data-edit-product="${escapeHtml(product.id)}">Edit</button>${product.status !== "Draft" ? `<button class="button danger small" type="button" data-archive-product="${escapeHtml(product.id)}">Archive</button>` : ""}</div></td></tr>`).join("") : `<tr><td colspan="8"><div class="empty-state">${state.products.length ? "No products match that search." : "No products yet. Add your first product to get started."}</div></td></tr>`}</tbody></table></div></section>`;
  }

  function renderInventory() {
    const lowStock = state.products.filter((product) => product.status !== "Draft" && product.stock <= product.minStock);
    const movements = state.movements || [];
    content.innerHTML = `<div class="stats-grid">${stat("Stock units", state.products.reduce((sum, product) => sum + Number(product.stock || 0), 0), "Across all products")}${stat("Low-stock items", lowStock.length, "At or below their reorder level", lowStock.length > 0)}${stat("Recent movements", movements.length, "Recorded stock changes")}${stat("Out of stock", state.products.filter((product) => product.stock === 0).length, "Products with no units available")}</div>
      <section class="card table-card"><div class="card-heading"><div><h2>Stock by product</h2><p>Use edit to record a stock adjustment.</p></div></div><div class="table-wrap"><table><thead><tr><th>PRODUCT</th><th>SKU</th><th>ON HAND</th><th>REORDER AT</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>${state.products.length ? state.products.map((product) => `<tr><td><strong>${escapeHtml(product.name)}</strong></td><td>${escapeHtml(product.sku)}</td><td><strong>${escapeHtml(product.stock)}</strong></td><td>${escapeHtml(product.minStock)}</td><td><span class="status ${product.stock <= product.minStock ? "pending" : "active"}">${product.stock === 0 ? "Out of stock" : product.stock <= product.minStock ? "Low stock" : "In stock"}</span></td><td><button class="button secondary small" type="button" data-edit-product="${escapeHtml(product.id)}">Adjust stock</button></td></tr>`).join("") : `<tr><td colspan="6"><div class="empty-state">No products in your catalog.</div></td></tr>`}</tbody></table></div></section>
      <section class="card table-card" style="margin-top:15px"><div class="card-heading"><div><h2>Recent stock movements</h2><p>Receipts and adjustments recorded by your team.</p></div></div><div class="table-wrap"><table><thead><tr><th>SKU</th><th>CHANGE</th><th>REASON</th><th>REFERENCE</th><th>DATE</th></tr></thead><tbody>${movements.length ? movements.slice(0, 50).map((movement) => `<tr><td><strong>${escapeHtml(movement.sku)}</strong></td><td>${Number(movement.changeQuantity) > 0 ? "+" : ""}${escapeHtml(movement.changeQuantity)}</td><td>${escapeHtml(movement.reason)}</td><td>${escapeHtml(movement.reference || "—")}</td><td>${escapeHtml(date(movement.createdAt))}</td></tr>`).join("") : `<tr><td colspan="5"><div class="empty-state">No stock movements recorded yet.</div></td></tr>`}</tbody></table></div></section>`;
  }

  function renderOrders() {
    $("#heading-actions").innerHTML = `<button class="button secondary" type="button" data-action="export-orders">Export CSV</button>`;
    content.innerHTML = orderTable(state.orders);
  }

  function renderExpenses() {
    $("#heading-actions").innerHTML = `<button class="button" type="button" data-action="add-expense">＋ Record expense</button>`;
    const total = state.expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
    content.innerHTML = `<div class="stats-grid">${stat("Recorded expenses", state.expenses.length, "Operating costs")}${stat("Total recorded", money(total), "Across listed expenses")}</div><section class="card table-card"><div class="card-heading"><div><h2>Recent expenses</h2><p>Operating costs entered in the business studio.</p></div></div><div class="table-wrap"><table><thead><tr><th>DATE</th><th>CATEGORY</th><th>DESCRIPTION</th><th>REFERENCE</th><th>AMOUNT</th></tr></thead><tbody>${state.expenses.length ? state.expenses.map((expense) => `<tr><td>${escapeHtml(date(expense.date))}</td><td>${escapeHtml(expense.category)}</td><td><strong>${escapeHtml(expense.description)}</strong></td><td>${escapeHtml(expense.reference || "—")}</td><td><strong>${money(expense.amount)}</strong></td></tr>`).join("") : `<tr><td colspan="5"><div class="empty-state">No expenses recorded yet.</div></td></tr>`}</tbody></table></div></section>`;
  }

  function renderReports() {
    const report = state.overview;
    $("#heading-actions").innerHTML = `<label class="report-controls"><span class="sr-only">Report period</span><select class="inline-control" id="report-range" aria-label="Report period"><option value="7" ${state.range === 7 ? "selected" : ""}>Last 7 days</option><option value="30" ${state.range === 30 ? "selected" : ""}>Last 30 days</option><option value="90" ${state.range === 90 ? "selected" : ""}>Last 90 days</option><option value="365" ${state.range === 365 ? "selected" : ""}>Last 12 months</option></select></label>`;
    content.innerHTML = `<div class="stats-grid">${stat("Revenue", money(report.revenue), `Last ${report.periodDays} days`)}${stat("Purchase cost", money(report.purchaseCost), "Cost of goods sold")}${stat("Gross profit", money(report.grossProfit), "Revenue less purchase cost", true)}${stat("Operating expenses", money(report.expenses), "Recorded business expenses")}</div><section class="card"><div class="card-heading"><div><h2>Profit summary</h2><p>Recognized revenue includes delivered orders only.</p></div></div><div class="metric-list"><div class="metric-box"><span>Net profit</span><strong>${money(report.netProfit)}</strong></div><div class="metric-box"><span>Orders delivered</span><strong>${escapeHtml(report.deliveredOrders)}</strong></div><div class="metric-box"><span>Average revenue per delivered order</span><strong>${money(report.deliveredOrders ? report.revenue / report.deliveredOrders : 0)}</strong></div><div class="metric-box"><span>Inventory at cost</span><strong>${money(report.inventoryValue)}</strong></div><div class="metric-box"><span>Products in catalog</span><strong>${escapeHtml(report.products)}</strong></div><div class="metric-box"><span>Units sold</span><strong>${escapeHtml(report.unitsSold)}</strong></div></div><p class="hint">Amounts reflect the current selected reporting period. Historical order totals are preserved when catalog prices change.</p></section>`;
  }

  function renderTeam() {
    const canManage = state.user.role === "super_admin";
    $("#heading-actions").innerHTML = canManage ? `<button class="button" type="button" data-action="invite-user">＋ Invite teammate</button>` : "";
    content.innerHTML = `<section class="card table-card"><div class="card-heading"><div><h2>Access and accounts</h2><p>Every teammate needs their own account and authenticator enrollment.</p></div></div><div class="table-wrap"><table><thead><tr><th>EMAIL</th><th>ROLE</th><th>MFA</th><th>STATUS</th>${canManage ? "<th>MANAGE</th>" : ""}</tr></thead><tbody>${state.users.length ? state.users.map((user) => `<tr><td><strong>${escapeHtml(user.email)}</strong><span class="sub-cell">Joined ${escapeHtml(date(user.createdAt))}</span></td><td><span class="status ${statusClass(user.role)}">${escapeHtml(user.role.replace("_", " "))}</span></td><td>${user.mfaEnabled ? "Enrolled" : "Not enrolled"}</td><td><span class="status ${user.active ? "active" : "inactive"}">${user.active ? "Active" : "Disabled"}</span></td>${canManage ? `<td><button class="button secondary small" type="button" data-edit-user="${escapeHtml(user.id)}">Manage</button></td>` : ""}</tr>`).join("") : `<tr><td colspan="${canManage ? 5 : 4}"><div class="empty-state">No team accounts found.</div></td></tr>`}</tbody></table></div>${canManage ? "" : `<p class="hint">Only a Super Admin can invite teammates or change account access.</p>`}</section>`;
  }

  async function loadPanel(panel) {
    if (!allowedPanels().includes(panel)) return;
    const requestId = ++state.loadRequestId;
    state.panel = panel;
    clearNotice();
    setHeading(panel);
    content.setAttribute("aria-busy", "true");
    content.innerHTML = `<div class="loading-state"><span class="spinner"></span>Loading ${escapeHtml(panelInfo[panel][0].toLowerCase())}…</div>`;
    try {
      if (panel === "overview") {
        const [overview, orders] = await Promise.all([
          request(`/admin/overview?days=${state.range}`),
          request("/admin/orders")
        ]);
        if (requestId !== state.loadRequestId) return;
        state.overview = overview;
        state.orders = orders.orders;
        renderOverview();
      } else if (panel === "products") {
        const data = await request("/admin/products");
        if (requestId !== state.loadRequestId) return;
        state.products = data.products;
        renderProducts();
      } else if (panel === "inventory") {
        const [products, movements] = await Promise.all([request("/admin/products"), request("/admin/stock-movements")]);
        if (requestId !== state.loadRequestId) return;
        state.products = products.products;
        state.movements = movements.movements;
        renderInventory();
      } else if (panel === "orders") {
        const data = await request("/admin/orders");
        if (requestId !== state.loadRequestId) return;
        state.orders = data.orders;
        renderOrders();
      } else if (panel === "expenses") {
        const data = await request("/admin/expenses");
        if (requestId !== state.loadRequestId) return;
        state.expenses = data.expenses;
        renderExpenses();
      } else if (panel === "reports") {
        const overview = await request(`/admin/overview?days=${state.range}`);
        if (requestId !== state.loadRequestId) return;
        state.overview = overview;
        renderReports();
      } else if (panel === "team") {
        const data = await request("/admin/users");
        if (requestId !== state.loadRequestId) return;
        state.users = data.users;
        renderTeam();
      }
    } catch (error) {
      if (requestId !== state.loadRequestId) return;
      content.innerHTML = `<div class="empty-state"><strong>We couldn’t load this section.</strong><span>${escapeHtml(error.message)}</span><button class="button secondary" type="button" data-action="retry">Try again</button></div>`;
    } finally {
      if (requestId === state.loadRequestId) content.setAttribute("aria-busy", "false");
    }
  }

  function field(label, name, value = "", options = {}) {
    const type = options.type || "text";
    const required = options.required ? " required" : "";
    const min = options.min !== undefined ? ` min="${escapeHtml(options.min)}"` : "";
    const max = options.max !== undefined ? ` max="${escapeHtml(options.max)}"` : "";
    const step = options.step ? ` step="${escapeHtml(options.step)}"` : "";
    const full = options.full ? " full" : "";
    if (options.select) {
      return `<label class="field${full}">${escapeHtml(label)}<select name="${escapeHtml(name)}"${required}>${options.select.map((option) => `<option value="${escapeHtml(option)}" ${String(value) === option ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}</select></label>`;
    }
    if (options.textarea) return `<label class="field${full}">${escapeHtml(label)}<textarea name="${escapeHtml(name)}" maxlength="${escapeHtml(options.maxLength || 2000)}"${required}>${escapeHtml(value)}</textarea></label>`;
    return `<label class="field${full}">${escapeHtml(label)}<input name="${escapeHtml(name)}" type="${type}" value="${escapeHtml(value)}"${required}${min}${max}${step} ${type === "number" ? 'inputmode="decimal"' : ""}></label>`;
  }

  function showDialog(title, body) {
    $("#dialog-title").textContent = title;
    dialogForm.innerHTML = body;
    dialog.showModal();
  }

  function openProductForm(product = null) {
    const item = product || {
      name: "", sku: "", category: "Men", description: "", image: "", cost: "",
      price: "", discountPrice: "", stock: 0, minStock: 5, supplier: "",
      sizes: ["S", "M", "L", "XL"], colors: [], status: "Active"
    };
    const form = `<input type="hidden" name="productId" value="${product ? escapeHtml(product.id) : ""}">
      <input type="hidden" name="image" value="${escapeHtml(item.image || "")}">
      <div class="form-grid">${field("PRODUCT NAME", "name", item.name, { required: true })}${field("SKU", "sku", item.sku, { required: true })}${field("CATEGORY", "category", item.category, { select: ["Men", "Women", "Accessories"] })}${field("STATUS", "status", item.status, { select: ["Active", "Draft"] })}${field("SELLING PRICE · ₹", "price", item.price, { type: "number", min: "0", step: "0.01", required: true })}${field("PURCHASE COST · ₹", "cost", item.cost, { type: "number", min: "0", step: "0.01", required: true })}${field("DISCOUNT PRICE · ₹", "discountPrice", item.discountPrice ?? "", { type: "number", min: "0", step: "0.01" })}${field("STOCK ON HAND", "stock", item.stock, { type: "number", min: "0", max: "100000", step: "1", required: true })}${field("LOW-STOCK ALERT AT", "minStock", item.minStock, { type: "number", min: "0", max: "100000", step: "1", required: true })}${field("SUPPLIER", "supplier", item.supplier)}<label class="field full">PRODUCT IMAGE · JPEG, PNG OR WEBP<input name="imageFile" type="file" accept="image/jpeg,image/png,image/webp"><span class="form-note">Choose an image from your device (maximum 5 MB). Leave empty to keep the current image.</span></label><div class="image-preview-wrap full">${item.image ? `<img class="image-preview" src="${escapeHtml(item.image)}" alt="Current product image">` : `<span class="image-preview-empty">No image selected</span>`}</div>${field("SIZES · COMMA SEPARATED", "sizes", (item.sizes || []).join(", "), { full: true })}${field("COLOURS · HEX VALUES SEPARATED BY COMMAS", "colors", (item.colors || []).join(", "), { full: true })}${field("DESCRIPTION", "description", item.description, { textarea: true, full: true })}</div>
      <p class="form-note">Only Active products with stock above zero appear in the storefront. Accessories use a single “One size” option. Enter colours as hex values, for example #b1a38e.</p><p class="form-error" id="dialog-error" role="alert"></p><div class="dialog-actions"><button class="button secondary" type="button" data-close-dialog>Cancel</button><button class="button" type="submit">Save product</button></div>`;
    showDialog(product ? "Edit product" : "Add a product", form);
    dialogForm.dataset.formAction = "product";
  }

  function openExpenseForm() {
    const categories = ["Rent", "Salaries", "Advertising", "Packaging", "Shipping", "Utilities", "Payment fees", "Website", "Miscellaneous"];
    showDialog("Record an expense", `<div class="form-grid">${field("CATEGORY", "category", "Packaging", { select: categories })}${field("AMOUNT · ₹", "amount", "", { type: "number", min: "0.01", step: "0.01", required: true })}${field("DATE", "date", new Date().toISOString().slice(0, 10), { type: "date", required: true })}${field("REFERENCE", "reference", "")}${field("DESCRIPTION", "description", "", { full: true, required: true })}</div><p class="form-error" id="dialog-error" role="alert"></p><div class="dialog-actions"><button class="button secondary" type="button" data-close-dialog>Cancel</button><button class="button" type="submit">Save expense</button></div>`);
    dialogForm.dataset.formAction = "expense";
  }

  function openInviteForm() {
    showDialog("Invite a teammate", `${field("EMAIL ADDRESS", "email", "", { type: "email", required: true })}${field("ROLE", "role", "staff", { select: ["admin", "staff"] })}<p class="form-note">The one-time invitation link expires after 24 hours. Share it through a trusted channel.</p><p class="form-error" id="dialog-error" role="alert"></p><div class="dialog-actions"><button class="button secondary" type="button" data-close-dialog>Cancel</button><button class="button" type="submit">Create invitation</button></div>`);
    dialogForm.dataset.formAction = "invite";
  }

  function openUserForm(user) {
    const roles = ["super_admin", "admin", "staff"];
    showDialog("Manage account", `<input type="hidden" name="userId" value="${escapeHtml(user.id)}"><p class="form-note">${escapeHtml(user.email)}</p>${field("ROLE", "role", user.role, { select: roles })}<label class="checkbox-row"><input type="checkbox" name="active" ${user.active ? "checked" : ""}> Account is active</label><p class="form-note">You cannot disable or demote your own Super Admin account. At least one active Super Admin must remain.</p><p class="form-error" id="dialog-error" role="alert"></p><div class="dialog-actions"><button class="button secondary" type="button" data-close-dialog>Cancel</button><button class="button" type="submit">Save access</button></div>`);
    dialogForm.dataset.formAction = "user";
  }

  function formValues(form) {
    return Object.fromEntries(new FormData(form));
  }

  async function submitProduct(form) {
    const values = formValues(form);
    const productId = values.productId;
    const imageFile = form.elements.imageFile.files[0];
    if (imageFile) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(imageFile.type)) {
        throw new Error("Choose a JPEG, PNG, or WebP image.");
      }
      if (imageFile.size > 5 * 1024 * 1024) throw new Error("The image must be 5 MB or smaller.");
      const upload = await fetch("/api/admin/product-images", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": imageFile.type, "X-CSRF-Token": state.csrfToken },
        body: imageFile
      });
      const uploaded = await upload.json().catch(() => ({}));
      if (!upload.ok) {
        const message = uploaded.error || `Image upload failed (${upload.status}).`;
        if (upload.status === 404 && /does not have that endpoint/i.test(message)) {
          throw new Error("This server hasn't been updated for image uploads yet. Restart the app with npm.cmd start, or redeploy the latest version, then reload Admin.");
        }
        throw new Error(message);
      }
      values.image = uploaded.image;
    }
    const product = {
      name: values.name.trim(),
      sku: values.sku.trim(),
      category: values.category,
      status: values.status,
      description: values.description.trim(),
      image: values.image.trim(),
      cost: Number(values.cost),
      price: Number(values.price),
      discountPrice: values.discountPrice === "" ? null : Number(values.discountPrice),
      stock: Number(values.stock),
      minStock: Number(values.minStock),
      supplier: values.supplier.trim(),
      sizes: values.sizes.split(",").map((value) => value.trim()).filter(Boolean),
      colors: values.colors.split(",").map((value) => value.trim()).filter(Boolean)
    };
    if (product.category === "Accessories") product.sizes = ["One size"];
    if (!product.sizes.length) throw new Error("Enter at least one size.");
    if (product.colors.some((color) => !/^#[0-9a-fA-F]{6}$/.test(color))) throw new Error("Each colour must be a six-digit hex value, such as #b1a38e.");
    await request(productId ? `/admin/products/${encodeURIComponent(productId)}` : "/admin/products", {
      method: productId ? "PATCH" : "POST", body: JSON.stringify(product)
    });
    dialog.close();
    notice(productId ? "Product updated." : "Product added.");
    await loadPanel(state.panel);
  }

  async function submitExpense(form) {
    const values = formValues(form);
    await request("/admin/expenses", {
      method: "POST",
      body: JSON.stringify({
        category: values.category, amount: Number(values.amount), date: values.date,
        reference: values.reference.trim(), description: values.description.trim()
      })
    });
    dialog.close();
    notice("Expense recorded.");
    await loadPanel("expenses");
  }

  async function submitInvitation(form) {
    const values = formValues(form);
    const data = await request("/admin/invitations", {
      method: "POST", body: JSON.stringify({ email: values.email.trim(), role: values.role })
    });
    const url = new URL(data.invitation.url, window.location.origin).href;
    dialogForm.innerHTML = `<p class="form-note">Invitation created for <strong>${escapeHtml(data.invitation.email)}</strong>. It expires ${escapeHtml(date(data.invitation.expiresAt))}.</p><label class="field">ONE-TIME INVITATION LINK<div class="copy-link"><input name="invitationUrl" value="${escapeHtml(url)}" readonly><button class="button secondary" type="button" data-copy-link>Copy</button></div></label><p class="form-note">Send this link only to the invited person through a trusted channel.</p><div class="dialog-actions"><button class="button" type="button" data-close-dialog>Done</button></div>`;
    dialogForm.dataset.formAction = "";
    notice("Invitation created. Copy and share its one-time link securely.");
  }

  async function submitUser(form) {
    const values = formValues(form);
    const user = state.users.find((item) => String(item.id) === String(values.userId));
    const active = form.elements.active.checked;
    const update = {};
    if (user.role !== values.role) update.role = values.role;
    if (user.active !== active) update.active = active;
    if (!Object.keys(update).length) {
      dialog.close();
      return;
    }
    await request(`/admin/users/${encodeURIComponent(values.userId)}`, { method: "PATCH", body: JSON.stringify(update) });
    dialog.close();
    notice("Account access updated.");
    await loadPanel("team");
  }

  async function saveOrder(id) {
    const select = $(`[data-order-status="${CSS.escape(String(id))}"]`);
    if (!select.value) throw new Error("Choose a new status before saving this order.");
    const restock = $(`[data-restock="${CSS.escape(String(id))}"]`)?.checked || false;
    await request(`/admin/orders/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify({ status: select.value, restock })
    });
    notice(`Order ${id} updated.`);
    await loadPanel("orders");
  }

  function csvCell(value) {
    let text = String(value ?? "");
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function downloadCsv(filename, headings, rows) {
    const csv = [headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportProducts() {
    downloadCsv("sr-clothing-products.csv",
      ["SKU", "Product", "Category", "Purchase cost INR", "Selling price INR", "Current stock", "Status"],
      state.products.map((product) => [product.sku, product.name, product.category, product.cost, product.price, product.stock, product.status]));
  }

  function exportOrders() {
    downloadCsv("sr-clothing-orders.csv",
      ["Order", "Customer", "Email", "Status", "Date", "Revenue INR"],
      state.orders.map((order) => [order.id, order.customerName, order.email, order.status, order.createdAt, order.total]));
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    try {
      if (button.dataset.panel || button.dataset.go) {
        const panel = button.dataset.panel || button.dataset.go;
        await loadPanel(panel);
        $("#admin-sidebar").classList.remove("open");
        $("#menu-button").setAttribute("aria-expanded", "false");
      } else if (button.dataset.action === "add-product") {
        openProductForm();
      } else if (button.dataset.action === "add-expense") {
        openExpenseForm();
      } else if (button.dataset.action === "invite-user") {
        openInviteForm();
      } else if (button.dataset.action === "retry") {
        await loadPanel(state.panel);
      } else if (button.dataset.action === "export-products") {
        exportProducts();
      } else if (button.dataset.action === "export-orders") {
        exportOrders();
      } else if (button.dataset.editProduct) {
        openProductForm(state.products.find((product) => String(product.id) === button.dataset.editProduct));
      } else if (button.dataset.archiveProduct) {
        const product = state.products.find((item) => String(item.id) === button.dataset.archiveProduct);
        if (product && window.confirm(`Archive ${product.name}? Its order history will be preserved.`)) {
          await request(`/admin/products/${encodeURIComponent(product.id)}`, { method: "PATCH", body: JSON.stringify({ status: "Draft" }) });
          notice("Product archived. Its order history is preserved.");
          await loadPanel("products");
        }
      } else if (button.dataset.saveOrder) {
        await saveOrder(button.dataset.saveOrder);
      } else if (button.dataset.editUser) {
        openUserForm(state.users.find((user) => String(user.id) === button.dataset.editUser));
      } else if (button.hasAttribute("data-close-dialog")) {
        dialog.close();
      } else if (button.hasAttribute("data-copy-link")) {
        const input = $('input[name="invitationUrl"]', dialogForm);
        await navigator.clipboard.writeText(input.value);
        button.textContent = "Copied";
      } else if (button.id === "menu-button") {
        const isOpen = $("#admin-sidebar").classList.toggle("open");
        button.setAttribute("aria-expanded", String(isOpen));
      }
    } catch (error) {
      if ($("#dialog-error") && !dialogForm.dataset.formAction.includes("invite")) {
        $("#dialog-error").textContent = error.message;
      } else notice(error.message, true);
    }
  });

  document.addEventListener("change", (event) => {
    const select = event.target.closest("[data-order-status]");
    if (select) {
      const row = $(`[data-restock-for="${CSS.escape(select.dataset.orderStatus)}"]`);
      const save = $(`[data-save-order="${CSS.escape(select.dataset.orderStatus)}"]`);
      if (save) save.disabled = !select.value;
      if (row) row.hidden = select.value !== "Refunded";
    }
    if (event.target.id === "report-range") {
      state.range = Number(event.target.value);
      loadPanel("reports");
    }
    if (event.target.name === "imageFile") {
      const preview = $(".image-preview-wrap", dialogForm);
      const file = event.target.files[0];
      preview.replaceChildren();
      if (file) {
        const image = document.createElement("img");
        image.className = "image-preview";
        image.alt = "Selected product image preview";
        image.src = URL.createObjectURL(file);
        preview.append(image);
      } else {
        const empty = document.createElement("span");
        empty.className = "image-preview-empty";
        empty.textContent = "No image selected";
        preview.append(empty);
      }
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "product-search") {
      const position = event.target.selectionStart;
      renderProducts();
      const search = $("#product-search");
      search.focus();
      search.setSelectionRange(position, position);
    }
  });

  dialogForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $('button[type="submit"]', dialogForm);
    const error = $("#dialog-error");
    if (error) error.textContent = "";
    submit.disabled = true;
    try {
      const action = dialogForm.dataset.formAction;
      if (action === "product") await submitProduct(dialogForm);
      else if (action === "expense") await submitExpense(dialogForm);
      else if (action === "invite") await submitInvitation(dialogForm);
      else if (action === "user") await submitUser(dialogForm);
    } catch (reason) {
      if ($("#dialog-error")) $("#dialog-error").textContent = reason.message;
      else notice(reason.message, true);
    } finally {
      if (submit.isConnected) submit.disabled = false;
    }
  });

  async function init() {
    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
      const session = await response.json();
      if (!response.ok || !session.user) {
        window.location.replace("/admin/login");
        return;
      }
      state.user = session.user;
      state.csrfToken = session.csrfToken || "";
      configureUser();
      const preferredPanel = state.user.role === "staff" ? "orders" : "overview";
      await loadPanel(preferredPanel);
    } catch (error) {
      content.setAttribute("aria-busy", "false");
      content.innerHTML = `<div class="empty-state"><strong>Your workspace could not be opened.</strong><span>${escapeHtml(error.message)}</span><a class="button secondary" href="/admin/login">Return to sign in</a></div>`;
    }
  }

  init();
})();
