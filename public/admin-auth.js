"use strict";

(() => {
  const form = document.querySelector("form");
  if (!form) return;
  const error = document.getElementById("auth-error");
  const invitationToken = form.id === "invite-form"
    ? new URLSearchParams(window.location.search).get("token") || ""
    : "";
  if (invitationToken) window.history.replaceState(null, "", "/admin/invite");
  const send = async (path, body, csrfToken) => {
    const response = await fetch(`/api${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {})
      },
      body: JSON.stringify(body)
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(data?.error || "Unable to complete sign in.");
    return data;
  };
  const showError = (reason) => { error.textContent = reason.message; };

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

  if (form.id === "mfa-form") {
    let csrfToken = "";
    fetch("/api/auth/mfa/setup", { credentials: "same-origin" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load authenticator setup.");
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
