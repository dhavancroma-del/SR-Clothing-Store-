"use strict";

// Track activity separately from the server-validated session expiration.
let inactivityTimer;
let lastActivityAt = Date.now();
const resetInactivityTimer = () => {
  // Lock the private dashboard after twenty minutes without user input.
  lastActivityAt = Date.now();
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => window.location.replace("/admin/login"), 20 * 60 * 1000);
};

["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
  document.addEventListener(eventName, resetInactivityTimer, { passive: true });
});
resetInactivityTimer();
// Refresh active sessions while the dashboard is visible and recently used.
setInterval(async () => {
  if (document.visibilityState !== "visible" || Date.now() - lastActivityAt >= 60 * 1000) return;
  try {
    const response = await fetch("/api/auth/session", { credentials: "same-origin" });
    const state = await response.json();
    if (!response.ok || !state.user) window.location.replace("/admin/login");
  } catch (error) {
    console.error("Unable to refresh the admin session:", error);
  }
}, 60 * 1000);

document.addEventListener("click", async (event) => {
  // Intercept sign-out to send the session's CSRF token before redirecting.
  const button = event.target.closest("#logout-button");
  if (!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  try {
    const session = await fetch("/api/auth/session", { credentials: "same-origin" });
    if (!session.ok) throw new Error("Unable to verify this session before signing out.");
    const state = await session.json();
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": state.csrfToken || ""
      },
      body: "{}"
    });
    if (!response.ok) throw new Error("Sign out could not be completed. Reload the page and try again.");
    window.location.replace("/admin/login");
  } catch (error) {
    window.alert(error.message);
  }
}, true);
