(() => {
  const TOKEN_KEY = "kaasupay_demo_token";
  const USER_KEY = "kaasupay_demo_user";
  const authView = document.getElementById("auth-view");
  const appView = document.getElementById("app-view");
  const authForm = document.getElementById("auth-form");
  const authMessage = document.getElementById("auth-message");
  const appNotice = document.getElementById("app-notice");
  const activityList = document.getElementById("activity-list");
  const bankSelect = document.getElementById("bank-select");
  let authMode = "signin";
  let historyPage = 1;
  let historyTotal = 0;
  let withdrawalAttempt = null;
  const historyLimit = 8;

  const money = (paise) => new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format((Number(paise) || 0) / 100);

  function showNotice(element, message, kind = "") {
    element.textContent = message;
    element.className = `notice ${kind}`.trim();
    element.hidden = false;
  }

  function hideNotice(element) {
    element.hidden = true;
    element.textContent = "";
  }

  async function api(path, options = {}) {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const headers = new Headers(options.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    let response;
    try {
      response = await fetch(path, { ...options, headers });
    } catch {
      throw new Error("Could not reach KaasuPay. Check your connection and try again.");
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status}).`);
    return data;
  }

  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === "signup";
    document.getElementById("signin-tab").classList.toggle("active", !signup);
    document.getElementById("signup-tab").classList.toggle("active", signup);
    document.getElementById("signin-tab").setAttribute("aria-selected", String(!signup));
    document.getElementById("signup-tab").setAttribute("aria-selected", String(signup));
    document.getElementById("name-fields").hidden = !signup;
    document.querySelector('[name="password"]').autocomplete = signup ? "new-password" : "current-password";
    document.getElementById("auth-title").textContent = signup ? "Your next chapter starts here." : "Good to see you again.";
    document.getElementById("auth-subtitle").textContent = signup
      ? "Create your account and set up your wallet."
      : "Sign in to pick up where you left off.";
    document.querySelector("#auth-submit span:first-child").textContent = signup ? "Create account" : "Sign in";
    hideNotice(authMessage);
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    if (busy) {
      button.dataset.originalText = button.querySelector("span")?.textContent || button.textContent.trim();
      if (button.querySelector("span")) button.querySelector("span").textContent = label;
      else button.textContent = label;
    } else {
      if (button.querySelector("span")) button.querySelector("span").textContent = button.dataset.originalText || label;
      else button.textContent = button.dataset.originalText || label;
    }
  }

  async function submitAuth(event) {
    event.preventDefault();
    hideNotice(authMessage);
    const formData = new FormData(authForm);
    const payload = {
      username: String(formData.get("username") || "").trim(),
      password: String(formData.get("password") || ""),
    };
    if (!authForm.elements.username.checkValidity()) {
      showNotice(authMessage, "Enter a valid email address.", "error");
      return;
    }
    if (authMode === "signup") {
      payload.firstName = String(formData.get("firstName") || "").trim();
      payload.lastName = String(formData.get("lastName") || "").trim();
      if (!payload.firstName || !payload.lastName) {
        showNotice(authMessage, "Please enter your first and last name.", "error");
        return;
      }
      if (payload.password.length < 6) {
        showNotice(authMessage, "Your password must be at least 6 characters.", "error");
        return;
      }
    }

    const button = document.getElementById("auth-submit");
    setBusy(button, true, authMode === "signup" ? "Creating…" : "Signing in…");
    try {
      if (authMode === "signup") {
        await api("/api/v1/user/signup", { method: "POST", body: JSON.stringify(payload) });
        setAuthMode("signin");
        authForm.elements.username.value = payload.username;
        authForm.elements.password.value = "";
        showNotice(authMessage, "Account created. Sign in with your new details to continue.", "success");
        return;
      }

      const result = await api("/api/v1/user/signin", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      sessionStorage.setItem(TOKEN_KEY, result.token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(result.user));
      authForm.reset();
      await showDashboard(result.user);
    } catch (error) {
      showNotice(authMessage, error.message, "error");
    } finally {
      setBusy(button, false, authMode === "signup" ? "Create account" : "Sign in");
    }
  }

  async function showDashboard(initialUser) {
    const cachedUser = initialUser || JSON.parse(sessionStorage.getItem(USER_KEY) || "null");
    if (!sessionStorage.getItem(TOKEN_KEY)) {
      showAuth();
      return;
    }
    authView.hidden = true;
    appView.hidden = false;
    document.getElementById("today-date").textContent = new Intl.DateTimeFormat("en-IN", {
      weekday: "short", day: "numeric", month: "short", year: "numeric",
    }).format(new Date());

    try {
      const { user } = await api("/api/v1/user/me");
      sessionStorage.setItem(USER_KEY, JSON.stringify(user));
      updateProfile(user);
      await refreshDashboard();
    } catch (error) {
      if (/sign in|session|unauthorized|expired/i.test(error.message)) {
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(USER_KEY);
        showAuth();
      } else {
        updateProfile(cachedUser || {});
        showNotice(appNotice, error.message, "error");
      }
    }
  }

  function updateProfile(user) {
    const name = user.firstName || user.username?.split("@")[0] || "there";
    document.getElementById("profile-name").textContent = `${user.firstName || name} ${user.lastName || ""}`.trim();
    document.getElementById("profile-email").textContent = user.username || "";
    document.getElementById("welcome-name").textContent = name;
    document.getElementById("avatar").textContent = (user.firstName || user.username || "K").charAt(0).toUpperCase();
  }

  function showAuth() {
    appView.hidden = true;
    authView.hidden = false;
  }

  async function refreshDashboard() {
    hideNotice(appNotice);
    await Promise.all([loadBalance(), loadHistory(historyPage), loadBankAccounts(), loadWithdrawals()]);
  }

  async function loadBalance() {
    const result = await api("/api/v1/wallet/balance");
    document.getElementById("wallet-balance").textContent = result.display || money(result.balance);
    document.getElementById("balance-updated").textContent = `Updated ${new Intl.DateTimeFormat("en-IN", {
      hour: "numeric", minute: "2-digit",
    }).format(new Date())}`;
  }

  function dateLabel(value) {
    if (!value) return "Date unavailable";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Date unavailable";
    return new Intl.DateTimeFormat("en-IN", {
      day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
    }).format(date);
  }

  function transactionTitle(transaction) {
    if (transaction.description) return transaction.description;
    const labels = { TRANSFER: "Wallet transfer", DEPOSIT: "Wallet deposit", TOPUP: "Wallet top-up", WITHDRAWAL: "Bank withdrawal", REVERSAL: "Withdrawal refund" };
    return labels[transaction.type] || "Wallet activity";
  }

  async function loadHistory(page) {
    activityList.innerHTML = '<div class="empty-state"><span class="loader"></span><p>Loading your activity…</p></div>';
    try {
      const result = await api(`/api/v1/wallet/transactions?page=${page}&limit=${historyLimit}`);
      historyPage = result.page || page;
      historyTotal = result.total || 0;
      const entries = result.transactions || [];
      if (!entries.length) {
        activityList.innerHTML = '<div class="empty-state"><p>No activity yet. Your wallet transactions will show up here.</p></div>';
      } else {
        activityList.innerHTML = entries.map((transaction) => {
          const inbound = transaction.direction === "IN";
          const sign = inbound ? "+" : "−";
          const status = transaction.type === "WITHDRAWAL" ? "Requested" : transaction.type === "REVERSAL" ? "Refunded" : "Recorded";
          return `<div class="activity-row">
            <span class="activity-symbol ${inbound ? "" : "out"}" aria-hidden="true">${inbound ? "↙" : "↗"}</span>
            <span class="activity-copy"><strong>${escapeHtml(transactionTitle(transaction))}</strong><small>${escapeHtml(dateLabel(transaction.createdAt))}</small></span>
            <span class="activity-value"><strong class="${inbound ? "positive" : "negative"}">${sign}${escapeHtml(money(transaction.amount))}</strong><small>${status}</small></span>
          </div>`;
        }).join("");
      }
      renderPagination();
    } catch (error) {
      activityList.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  function renderPagination() {
    const container = document.getElementById("activity-pagination");
    const pages = Math.ceil(historyTotal / historyLimit);
    container.hidden = pages <= 1;
    if (pages <= 1) return;
    container.innerHTML = "";
    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "← Newer";
    previous.disabled = historyPage <= 1;
    previous.addEventListener("click", () => loadHistory(Math.max(1, historyPage - 1)));
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "Older →";
    next.disabled = historyPage >= pages;
    next.addEventListener("click", () => loadHistory(Math.min(pages, historyPage + 1)));
    container.append(previous, next);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  async function loadBankAccounts() {
    try {
      const result = await api("/api/v1/wallet/bank-accounts");
      const accounts = result.bankAccounts || [];
      bankSelect.innerHTML = accounts.length
        ? '<option value="">Choose a saved bank account</option>'
        : '<option value="">Add a bank account first</option>';
      for (const account of accounts) {
        const option = document.createElement("option");
        option.value = account.id;
        option.textContent = `${account.accountHolderName} · ${account.accountNumber} · ${account.ifsc}`;
        bankSelect.append(option);
      }
    } catch (error) {
      bankSelect.innerHTML = '<option value="">Could not load accounts</option>';
      showNotice(appNotice, error.message, "error");
    }
  }

  async function loadWithdrawals() {
    const container = document.getElementById("withdrawal-list");
    try {
      const result = await api("/api/v1/wallet/withdrawals?page=1&limit=5");
      const withdrawals = result.withdrawals || [];
      if (!withdrawals.length) {
        container.innerHTML = '<div class="empty-state"><p>No withdrawal requests yet.</p></div>';
        return;
      }
      container.innerHTML = withdrawals.map((withdrawal) => {
        const status = String(withdrawal.status || "PENDING");
        const stateClass = status.toLowerCase();
        const detail = withdrawal.failureReason || withdrawal.bankAccount?.accountNumber || "Payout request";
        return `<div class="withdrawal-row">
          <span class="withdrawal-row-copy"><strong>${escapeHtml(money(withdrawal.amount))} · ${escapeHtml(detail)}</strong><small>${escapeHtml(dateLabel(withdrawal.updatedAt || withdrawal.createdAt))}</small></span>
          <span class="withdrawal-state ${escapeHtml(stateClass)}">${escapeHtml(status.replaceAll("_", " "))}</span>
        </div>`;
      }).join("");
    } catch (error) {
      container.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  async function submitBankAccount(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = document.getElementById("bank-submit");
    setBusy(button, true, "Saving…");
    try {
      const values = new FormData(form);
      const result = await api("/api/v1/wallet/bank-accounts", {
        method: "POST",
        body: JSON.stringify({
          accountHolderName: values.get("accountHolderName"),
          accountNumber: values.get("accountNumber"),
          ifsc: values.get("ifsc"),
          testScenario: values.get("testScenario"),
        }),
      });
      form.reset();
      await loadBankAccounts();
      showNotice(appNotice, `Bank account ending ${result.bankAccount.accountNumber.slice(-4)} saved.`, "success");
    } catch (error) {
      showNotice(appNotice, error.message, "error");
    } finally {
      setBusy(button, false, "Save bank account");
    }
  }

  async function submitWithdrawal(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const amountText = String(values.get("amount") || "").trim();
    const amountMatch = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amountText);
    const amount = amountMatch
      ? Number(amountMatch[1]) * 100 + Number((amountMatch[2] || "").padEnd(2, "0"))
      : 0;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      showNotice(appNotice, "Enter a valid amount with at most two decimal places.", "error");
      return;
    }
    if (!values.get("bankAccountId")) {
      showNotice(appNotice, "Add or choose a bank account first.", "error");
      return;
    }

    const requestFingerprint = `${values.get("bankAccountId")}:${amount}`;
    if (!withdrawalAttempt || withdrawalAttempt.fingerprint !== requestFingerprint) {
      withdrawalAttempt = { key: crypto.randomUUID(), fingerprint: requestFingerprint };
    }
    const button = document.getElementById("withdraw-submit");
    setBusy(button, true, "Submitting…");
    try {
      const result = await api("/api/v1/wallet/withdrawals", {
        method: "POST",
        headers: { "Idempotency-Key": withdrawalAttempt.key },
        body: JSON.stringify({
          bankAccountId: values.get("bankAccountId"),
          amount,
        }),
      });
      withdrawalAttempt = null;
      form.reset();
      await refreshDashboard();
      const status = result.withdrawal?.status || "PENDING";
      showNotice(appNotice, result.replayed
        ? `Existing withdrawal request ${result.withdrawal.id} was returned (${status}).`
        : `Withdrawal request accepted (${status}). Track its progress in recent activity or refresh shortly.`, "success");
    } catch (error) {
      showNotice(appNotice, error.message, "error");
    } finally {
      setBusy(button, false, "Request withdrawal");
    }
  }

  document.getElementById("signin-tab").addEventListener("click", () => setAuthMode("signin"));
  document.getElementById("signup-tab").addEventListener("click", () => setAuthMode("signup"));
  authForm.addEventListener("submit", submitAuth);
  document.getElementById("signout-button").addEventListener("click", () => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    showAuth();
    showNotice(authMessage, "You have signed out.", "success");
  });
  document.getElementById("refresh-button").addEventListener("click", () => refreshDashboard().catch((error) => showNotice(appNotice, error.message, "error")));
  document.getElementById("activity-refresh").addEventListener("click", () => loadHistory(historyPage));
  document.getElementById("withdrawal-refresh").addEventListener("click", () => loadWithdrawals());
  document.getElementById("bank-form").addEventListener("submit", submitBankAccount);
  document.getElementById("withdraw-form").addEventListener("submit", submitWithdrawal);

  document.querySelectorAll(".nav-link[href^='#']").forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".nav-link[href^='#']").forEach((item) => item.classList.remove("active"));
      link.classList.add("active");
      document.querySelector(link.getAttribute("href"))?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  if (sessionStorage.getItem(TOKEN_KEY)) {
    showDashboard().catch((error) => showNotice(appNotice, error.message, "error"));
  } else {
    showAuth();
  }
})();
