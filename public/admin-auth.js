"use strict";

(() => {
  // Share one form handler across login, MFA enrollment, and invitation pages.
  const form = document.querySelector("form");
  if (!form) return;
  const error = document.getElementById("auth-error");
  const invitationToken = form.id === "invite-form"
    ? new URLSearchParams(window.location.search).get("token") || ""
    : "";
  if (invitationToken) window.history.replaceState(null, "", "/admin/invite");
  const rateLimitMessage = "Too many attempts. Please wait 15 minutes before trying again.";
  const readResponse = async (response, fallback) => {
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    let data = null;
    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch {
        throw new Error(fallback);
      }
    } else {
      await response.text();
    }
    if (!response.ok) {
      throw new Error(data?.error || (response.status === 429 ? rateLimitMessage : fallback));
    }
    if (!contentType.includes("application/json")) throw new Error(fallback);
    return data;
  };
  const send = async (path, body, csrfToken) => {
    // Keep requests same-origin and attach the one-time CSRF token when required.
    const response = await fetch(`/api${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {})
      },
      body: JSON.stringify(body)
    });
    return readResponse(response, "Unable to complete sign in.");
  };
  const showError = (reason) => { error.textContent = reason.message; };

  // Authenticate staff and route first-time users to required MFA enrollment.
  if (form.id === "login-form") {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      try {
        const values = Object.fromEntries(new FormData(form));
        const result = await send("/auth/login", {
          email: values.email,
          password: values.password,
          ...(values.otp ? { otp: values.otp } : {})
        });
        window.location.assign(result.user.mfaEnabled ? "/admin" : "/admin/mfa-setup");
      } catch (reason) { showError(reason); }
    });
  }

  // Load the pending MFA secret, then verify the first authenticator code.
  if (form.id === "mfa-form") {
    let csrfToken = "";
    fetch("/api/auth/mfa/setup", { credentials: "same-origin" })
      .then(async (response) => {
        const data = await readResponse(response, "Unable to load authenticator setup.");
        csrfToken = data.csrfToken;
        document.getElementById("mfa-secret").textContent = data.secret;
      })
      .catch(showError);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      try {
        const result = await send("/auth/mfa/verify", { otp: new FormData(form).get("otp") }, csrfToken);
        window.location.assign("/admin");
      } catch (reason) { showError(reason); }
    });
  }

  // Accept one-time invitations only after matching the two password fields.
  if (form.id === "invite-form") {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      const values = Object.fromEntries(new FormData(form));
      if (values.password !== values.confirmPassword) {
        error.textContent = "The passwords do not match.";
        return;
      }
      try {
        const result = await send("/auth/invitations/accept", { token: invitationToken, password: values.password });
        window.location.assign(result.user.mfaEnabled ? "/admin" : "/admin/mfa-setup");
      } catch (reason) { showError(reason); }
    });
  }
})();
