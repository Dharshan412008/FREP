const BASE_URL = "";

const API_ENDPOINTS = Object.freeze({
  copilotAct: "/api/copilot/act",
  copilotActConfirm: "/api/copilot/act/confirm",
  events: "/api/events",
});

const state = {
  authenticated: false,
  offlineReadOnly: false,
  user: null,
  currentRole: "",
  workspaceLoaded: false,
  view: "overview",
  resources: [],
  clusters: [],
  bookings: [],
  notifications: [],
  dashboard: {},
  analytics: { categories: [], listed: [], demand: [], trendLabels: [], trend: [], carbonSavings: 0 },
  productionPlan: null,
  clusterFilter: "",
  verifiedOnly: false,
  availableOnly: false,
  cart: [],
  copilotOpen: false,
  actDraft: null,
};

class ApiError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

const summaryLabels = {
  resources_listed: "Resources listed",
  available_resources: "Available resources",
  pending_verifications: "Pending verification",
  verified_msmes: "Verified MSMEs",
  average_cost_per_day: "Average cost/day",
  active_bookings: "Active bookings",
  capex_avoided: "Estimated capex avoided",
  carbonSavings: "Estimated CO2e avoided (kg)",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toast(message) {
  const host = document.getElementById("toastHost");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function fetchJson(url, options = {}) {
  const { suppressAuth = false, ...fetchOptions } = options;
  const method = String(fetchOptions.method || "GET").toUpperCase();
  if (state.offlineReadOnly && !["GET", "HEAD"].includes(method)) {
    throw new ApiError("Offline read-only mode: reconnect and sign in before making changes.", 503);
  }
  const headers = new Headers(fetchOptions.headers || {});
  if (fetchOptions.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const res = await fetch(`${BASE_URL}${url}`, {
    credentials: "same-origin",
    ...fetchOptions,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const apiMessage = typeof data?.error === "string" ? data.error : data?.error?.message;
    const message = apiMessage || data?.message || `Request failed (${res.status})`;
    if (res.status === 401 && !suppressAuth) requireAuthentication("Your session expired. Sign in again to continue.");
    throw new ApiError(message, res.status, data);
  }
  return data;
}

async function init() {
  const savedTheme = localStorage.getItem("frep-theme");
  const systemTheme = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  applyTheme(savedTheme || systemTheme);
  initializeCompose();
  // Optional Chrome origin-trial talking point: registration is fire-and-forget
  // so browsers without WebMCP follow the exact same FREP startup path.
  initializeWebMcpTools().catch(() => {});
  try {
    const session = await fetchJson("/api/auth/session", { suppressAuth: true });
    if (!session.authenticated || !session.user) {
      requireAuthentication();
      return;
    }
    applyAuthenticatedSession(session.user);
  } catch (error) {
    const sessionUnavailable = !(error instanceof ApiError) || error.status >= 500;
    if (sessionUnavailable && enterOfflineReadOnly("The server is unreachable. Showing the cached public catalogue.")) return;
    requireAuthentication(navigator.onLine ? "Sign in to continue." : "You are offline and no cached catalogue is available yet.");
    return;
  }
  await initializeWorkspace();
}

async function initializeWorkspace() {
  try {
    const status = await fetchJson("/api/ai/status");
    const chip = document.getElementById("engineChip");
    const engineLine = document.getElementById("copilotEngine");
    if (chip) chip.textContent = status.label || "Local AI · free";
    if (engineLine) engineLine.textContent = status.label || "On-device intelligence";
  } catch {
    /* copilot still works after first message */
  }
  const loaders = [loadDashboard(), loadResources(), loadClusters(), loadAnalytics(), loadNotifications()];
  if (state.currentRole === "buyer") loaders.push(loadBookings());
  const results = await Promise.allSettled(loaders);
  const publicDataLoaded = results.slice(0, 4).some((result) => result.status === "fulfilled");
  if (!publicDataLoaded && enterOfflineReadOnly("Live data could not be reached. Showing the cached public catalogue.")) return;
  if (!publicDataLoaded && !navigator.onLine) {
    requireAuthentication("You are offline and no cached catalogue is available yet.");
    return;
  }
  state.workspaceLoaded = true;
  render();
  connectLiveEvents();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

function requireAuthentication(message = "") {
  state.authenticated = false;
  state.offlineReadOnly = false;
  state.user = null;
  state.currentRole = "";
  state.workspaceLoaded = false;
  cancelAllCompose();
  stopAllVoiceInput();
  closeLiveEvents();
  clearActDraft();
  setCopilotOpen(false);
  const actInput = document.getElementById("actInput");
  const copilotInput = document.getElementById("copilotInput");
  if (actInput) actInput.value = "";
  if (copilotInput) copilotInput.value = "";
  document.getElementById("copilotThread")?.replaceChildren();
  const gate = document.getElementById("authGate");
  const shell = document.getElementById("appShell");
  const error = document.getElementById("loginError");
  if (gate) gate.hidden = false;
  if (shell) {
    shell.inert = true;
    shell.setAttribute("aria-hidden", "true");
  }
  document.body.classList.add("auth-required");
  document.body.removeAttribute("data-offline");
  const offlineBanner = document.getElementById("offlineBanner");
  if (offlineBanner) offlineBanner.hidden = true;
  const logoutButton = document.getElementById("logoutBtn");
  if (logoutButton) logoutButton.textContent = "Sign out";
  if (error) {
    error.textContent = message;
    error.hidden = !message;
  }
  window.setTimeout(() => document.getElementById("loginUsername")?.focus(), 0);
}

function applyAuthenticatedSession(user) {
  const role = String(user?.role || "").toLowerCase();
  if (!user || !["buyer", "owner", "admin"].includes(role)) {
    requireAuthentication("This account does not have a supported FREP role.");
    return;
  }
  state.authenticated = true;
  state.offlineReadOnly = false;
  state.user = { ...user, role };
  state.currentRole = role;
  state.view = "overview";
  document.body.dataset.role = role;
  document.body.removeAttribute("data-offline");
  document.body.classList.remove("auth-required");
  const gate = document.getElementById("authGate");
  const shell = document.getElementById("appShell");
  if (gate) gate.hidden = true;
  if (shell) {
    shell.inert = false;
    shell.removeAttribute("aria-hidden");
  }
  const password = document.getElementById("loginPassword");
  if (password) password.value = "";
  const offlineBanner = document.getElementById("offlineBanner");
  if (offlineBanner) offlineBanner.hidden = true;
  const logoutButton = document.getElementById("logoutBtn");
  if (logoutButton) logoutButton.textContent = "Sign out";
  updateRoleBadge();
  updateSectionVisibility();
  updateOfflineControls();
  updateComposeAvailability();
}

const PUBLIC_CACHE_KEY = "frep-public-workspace-v1";

function readPublicWorkspaceCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PUBLIC_CACHE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function updatePublicWorkspaceCache(patch) {
  if (state.offlineReadOnly) return;
  try {
    const previous = readPublicWorkspaceCache() || {};
    localStorage.setItem(PUBLIC_CACHE_KEY, JSON.stringify({ ...previous, ...patch, cachedAt: new Date().toISOString() }));
  } catch {
    /* A full or disabled storage area must not break the online workspace. */
  }
}

async function loadDashboard() {
  state.dashboard = await fetchJson("/api/dashboard");
  updatePublicWorkspaceCache({ dashboard: state.dashboard });
}

async function loadResources() {
  state.resources = await fetchJson("/api/resources");
  updatePublicWorkspaceCache({ resources: state.resources });
}

async function loadClusters() {
  state.clusters = await fetchJson("/api/clusters");
  updatePublicWorkspaceCache({ clusters: state.clusters });
}

async function loadBookings() {
  state.bookings = await fetchJson("/api/bookings");
}

async function loadAnalytics() {
  state.analytics = await fetchJson("/api/analytics");
  updatePublicWorkspaceCache({ analytics: state.analytics });
}

async function loadNotifications() {
  state.notifications = await fetchJson("/api/notifications");
}

function updateOfflineControls() {
  const disabled = state.offlineReadOnly;
  ["copilotInput", "copilotToggle", "commandOpenBtn", "parseNlBtn", "demoModeBtn"]
    .forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.disabled = disabled;
    });
  const actDisabled = disabled || state.currentRole === "admin" || !state.authenticated;
  ["actInput", "actDraftBtn"].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.disabled = actDisabled;
  });
  const roleNote = document.getElementById("actRoleNote");
  if (roleNote) roleNote.hidden = state.currentRole !== "admin";
  const copilotSubmit = document.querySelector("#copilotForm button[type='submit']");
  if (copilotSubmit) copilotSubmit.disabled = disabled;
}

function enterOfflineReadOnly(message = "Showing the last cached public catalogue.") {
  const cached = readPublicWorkspaceCache();
  const resources = cached?.resources || (state.resources.length ? state.resources : null);
  const dashboard = cached?.dashboard || (Object.keys(state.dashboard || {}).length ? state.dashboard : null);
  if (!resources && !dashboard) return false;
  stopAllVoiceInput();
  closeLiveEvents(false);
  clearActDraft();
  setCopilotOpen(false);
  const actInput = document.getElementById("actInput");
  const copilotInput = document.getElementById("copilotInput");
  if (actInput) actInput.value = "";
  if (copilotInput) copilotInput.value = "";
  document.getElementById("copilotThread")?.replaceChildren();
  state.authenticated = false;
  state.offlineReadOnly = true;
  state.user = null;
  state.currentRole = "offline";
  state.workspaceLoaded = true;
  state.resources = resources || [];
  state.dashboard = dashboard || {};
  state.clusters = cached?.clusters || state.clusters || [];
  state.analytics = cached?.analytics || state.analytics;
  state.bookings = [];
  state.notifications = [];
  state.cart = [];
  if (!["overview", "match", "network", "analytics"].includes(state.view)) state.view = "overview";
  document.body.dataset.role = "offline";
  document.body.dataset.offline = "true";
  document.body.classList.remove("auth-required");
  const gate = document.getElementById("authGate");
  const shell = document.getElementById("appShell");
  if (gate) gate.hidden = true;
  if (shell) {
    shell.inert = false;
    shell.removeAttribute("aria-hidden");
  }
  const banner = document.getElementById("offlineBanner");
  if (banner) {
    banner.hidden = false;
    const text = banner.querySelector("[data-offline-message]");
    if (text) text.textContent = `${message} Writes and Copilot actions are disabled.`;
  }
  const logoutButton = document.getElementById("logoutBtn");
  if (logoutButton) logoutButton.textContent = "Sign in";
  const engineChip = document.getElementById("engineChip");
  if (engineChip) engineChip.textContent = "Cached catalogue · read only";
  setLiveEventStatus("offline", "Offline · cached data");
  render();
  return true;
}

let onlineRecoveryPromise = null;

async function recoverOnlineSession() {
  if (onlineRecoveryPromise) return onlineRecoveryPromise;
  onlineRecoveryPromise = (async () => {
    const retry = document.getElementById("offlineRetryBtn");
    if (retry) retry.disabled = true;
    setLiveEventStatus("connecting", "Checking session…");
    try {
      const session = await fetchJson("/api/auth/session", { suppressAuth: true, cache: "no-store" });
      if (!session.authenticated || !session.user) {
        requireAuthentication("Connection restored. Sign in to continue.");
        return;
      }
      applyAuthenticatedSession(session.user);
      await initializeWorkspace();
      toast("Back online. Live workspace restored.");
    } catch (error) {
      if (state.offlineReadOnly) {
        const banner = document.getElementById("offlineBanner");
        const text = banner?.querySelector("[data-offline-message]");
        if (text) text.textContent = "Still offline. Showing cached public data; all writes remain disabled.";
        setLiveEventStatus("offline", "Offline · cached data");
      } else if (error instanceof ApiError && error.status === 401) {
        requireAuthentication("Your session expired. Sign in again to continue.");
      }
    } finally {
      if (retry) retry.disabled = false;
      onlineRecoveryPromise = null;
    }
  })();
  return onlineRecoveryPromise;
}

function getCurrentOwnerId() {
  return state.user?.ownerId || "";
}

function applyTheme(theme) {
  const selected = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", selected);
  localStorage.setItem("frep-theme", selected);
  const toggle = document.getElementById("themeToggle");
  if (toggle) {
    const nextTheme = selected === "light" ? "dark" : "light";
    toggle.textContent = `Theme: ${selected === "light" ? "Light" : "Dark"}`;
    toggle.setAttribute("aria-label", `Switch to ${nextTheme} theme`);
    toggle.setAttribute("aria-pressed", String(selected === "light"));
    toggle.title = `Switch to ${nextTheme} theme`;
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", selected === "light" ? "#d7d2c5" : "#0b1220");
}

function setView(view) {
  if (!isViewAllowed(view)) {
    toast("That workspace is not available for your signed-in role.");
    view = "overview";
  }
  state.view = view;
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  document.querySelectorAll(".panel[data-view]").forEach((panel) => {
    panel.hidden = panel.dataset.view !== view;
  });
}

function isViewAllowed(view) {
  if (view === "listings") return state.currentRole === "owner";
  if (view === "admin") return state.currentRole === "admin";
  if (view === "bookings" || view === "planner") return state.currentRole === "buyer";
  return true;
}

function setCopilotOpen(open) {
  state.copilotOpen = open;
  const panel = document.getElementById("copilotPanel");
  const shell = document.getElementById("appShell");
  if (panel) panel.hidden = !open;
  shell?.classList.toggle("copilot-open", open);
}

function render() {
  renderInputSuggestions();
  renderStats();
  renderMatchResults();
  renderMap();
  renderAdminQueue();
  renderOwnerListings();
  renderBookingOptions();
  renderBookings();
  renderNotifications();
  renderProductionPlan();
  renderAnalytics();
  updateRoleBadge();
  updateSectionVisibility();
  updateOfflineControls();
  setView(state.view);
}

function renderInputSuggestions() {
  const resources = state.resources || [];
  const clusters = [...(state.clusters || []).map((cluster) => cluster.name), ...resources.map((resource) => resource.cluster)];
  const resourceNames = resources.map((resource) => resource.name);
  const searchTerms = resources.flatMap((resource) => [
    resource.name,
    resource.category,
    resource.cluster,
    ...(resource.tags || []),
    ...(resource.capabilities || []),
  ]);
  setDatalistOptions("clusterSuggestions", clusters, (value) => {
    const cluster = state.clusters.find((item) => item.name === value);
    return cluster ? `${cluster.city}, ${cluster.state}` : "";
  });
  setDatalistOptions("resourceNameSuggestions", resourceNames);
  setDatalistOptions("resourceSearchSuggestions", searchTerms);
}

function setDatalistOptions(id, values, getLabel = () => "") {
  const list = document.getElementById(id);
  if (!list) return;
  const uniqueValues = [...new Set(values.filter(Boolean).map((value) => String(value).trim()))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  list.replaceChildren(...uniqueValues.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.label = getLabel(value);
    return option;
  }));
}

function updateRoleBadge() {
  const badge = document.getElementById("roleBadge");
  const name = document.getElementById("sessionName");
  const label = state.currentRole === "owner" ? "Resource Owner" : state.currentRole === "admin" ? "Network Admin" : "Buyer";
  if (badge) badge.textContent = state.offlineReadOnly ? "Offline catalogue" : state.authenticated ? label : "Signed out";
  if (name) name.textContent = state.offlineReadOnly ? "Read only" : state.authenticated ? (state.user?.name || state.user?.username || "") : "";
}

function updateSectionVisibility() {
  document.querySelectorAll(".owner-nav").forEach((el) => {
    el.style.display = state.currentRole === "owner" ? "" : "none";
  });
  document.querySelectorAll(".admin-nav").forEach((el) => {
    el.style.display = state.currentRole === "admin" ? "" : "none";
  });
  document.querySelectorAll(".buyer-nav").forEach((el) => {
    el.style.display = state.currentRole === "buyer" ? "" : "none";
  });
  const demoButton = document.getElementById("demoModeBtn");
  if (demoButton) demoButton.hidden = state.currentRole !== "buyer";
  if (state.currentRole !== "owner" && state.view === "listings") setView("overview");
  if (state.currentRole !== "admin" && state.view === "admin") setView("overview");
  if (state.currentRole !== "buyer" && state.view === "bookings") setView("overview");
  if (state.currentRole !== "buyer" && state.view === "planner") setView("overview");
}

function normalizeString(value) {
  return String(value || "").trim().toLowerCase();
}

function scoreMatch(resource, query) {
  const categoryFit = !query.resourceType || resource.category === query.resourceType ? 1 : 0.7;
  const locationFit = !query.cluster || normalizeString(resource.cluster).includes(normalizeString(query.cluster)) ? 1 : 0.7;
  const costFit = resource.pricePerDay <= query.budget ? 1 : Math.max(0.45, 1 - (resource.pricePerDay - query.budget) / (query.budget || 10000));
  const availabilityFit = resource.availability ? 1 : 0.2;
  const verificationBonus = resource.verified ? 1 : 0.6;
  const daysToDeadline = query.deadline ? Math.max(1, Math.ceil((new Date(query.deadline) - new Date()) / (1000 * 60 * 60 * 24))) : 7;
  const deadlineFit = daysToDeadline <= 3 ? (resource.availability ? 1 : 0.3) : 0.8;
  const compatibilityFit = query.search ? ((resource.tags || []).some((tag) => query.search.toLowerCase().includes(String(tag).toLowerCase())) ? 1 : 0.75) : 0.9;
  const trustFit = Math.min(1, (resource.trustScore || resource.rating * 20) / 100);
  const score = Math.round((categoryFit * 0.2 + locationFit * 0.16 + costFit * 0.16 + availabilityFit * 0.16 + verificationBonus * 0.12 + deadlineFit * 0.08 + compatibilityFit * 0.06 + trustFit * 0.06) * 100);
  const why = `${resource.availability ? "available now" : "limited availability"}, ${costFit >= 0.9 ? "within budget" : "above target budget"}, and ${resource.verified ? "verified" : "awaiting verification"}; category and location carry 36% of the score.`;
  return { score, why, breakdown: { categoryFit, locationFit, costFit, availabilityFit, verificationBonus, deadlineFit, compatibilityFit, trustFit } };
}

function getFilteredResources() {
  const resourceType = document.getElementById("resourceType")?.value;
  const cluster = state.clusterFilter || document.getElementById("clusterInput")?.value;
  const budget = Number(document.getElementById("budgetInput")?.value) || 999999;
  const search = document.getElementById("searchInput")?.value;
  return state.resources.filter((resource) => {
    const matchesType = !resourceType || resource.category === resourceType || normalizeString(resource.name).includes(normalizeString(resourceType));
    const matchesCluster = !cluster || normalizeString(resource.cluster).includes(normalizeString(cluster));
    const matchesSearch = !search || normalizeString(`${resource.name} ${resource.category} ${resource.cluster} ${(resource.tags || []).join(" ")}`).includes(normalizeString(search));
    const matchesBudget = resource.pricePerDay <= budget;
    const matchesVerified = !state.verifiedOnly || resource.verified;
    const matchesAvailable = !state.availableOnly || resource.availability;
    return matchesType && matchesCluster && matchesSearch && matchesBudget && matchesVerified && matchesAvailable;
  });
}

function renderStats() {
  const statsGrid = document.getElementById("statsGrid");
  if (!statsGrid) return;
  const data = { ...state.dashboard, ...(state.analytics ? { carbonSavings: state.analytics.carbonSavings } : {}) };
  statsGrid.innerHTML = Object.entries(summaryLabels)
    .map(([key, label]) => `
      <div class="stat-card">
        <div class="stat-label">${escapeHtml(label)}</div>
        <div class="stat-value">${data[key] != null ? escapeHtml(data[key]) : "—"}</div>
      </div>
    `)
    .join("");
}

function renderNotifications() {
  const notificationsPanel = document.getElementById("notificationsPanel");
  if (!notificationsPanel) return;
  if (!state.notifications.length) {
    notificationsPanel.innerHTML = '<div class="result-card">No new alerts right now.</div>';
    return;
  }
  notificationsPanel.innerHTML = state.notifications.map((note) => `
    <div class="result-card">
      <div class="result-head">
        <div>
          <strong>${escapeHtml(note.title)}</strong>
          <div class="muted">${escapeHtml(note.detail)}</div>
        </div>
        <span class="badge ${note.kind === "booking" ? "verified" : note.kind === "approval" ? "pending" : "muted"}">${escapeHtml(note.kind)}</span>
      </div>
    </div>
  `).join("");
}

function breakdownRows(breakdown = {}) {
  const labels = {
    categoryFit: "Category",
    locationFit: "Location",
    costFit: "Cost",
    availabilityFit: "Availability",
    verificationBonus: "Verified",
    deadlineFit: "Deadline",
    compatibilityFit: "Fit",
    trustFit: "Trust",
    capabilityCompatibility: "Capability",
    locationProximity: "Location",
    costEfficiency: "Cost",
    capacityAvailable: "Capacity",
    availability: "Availability",
    verification: "Verified",
    reliability: "Reliability",
    health: "Health",
    semantic: "Semantic",
    score: "Engine",
  };
  return Object.entries(breakdown)
    .filter(([key, value]) => key !== "why" && value != null)
    .map(([key, value]) => `<div class="score-factor"><span>${escapeHtml(labels[key] || humanizeFactor(key))}</span><span>${escapeHtml(formatFactorValue(value))}</span></div>`)
    .join("");
}

function humanizeFactor(key) {
  return String(key || "Factor")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatFactorValue(value) {
  if (typeof value === "number") return value >= 0 && value <= 1 ? `${Math.round(value * 100)}%` : `${Math.round(value * 100) / 100}`;
  if (typeof value !== "object") return String(value);
  const contribution = value.contribution ?? value.points ?? value.score ?? value.value;
  const weight = value.weight ?? value.weightPct ?? value.weight_percent;
  const pieces = [];
  if (contribution != null) {
    const numeric = Number(contribution);
    pieces.push(Number.isFinite(numeric) ? `${Math.round(numeric * 100) / 100} pts` : String(contribution));
  }
  if (weight != null) pieces.push(`${Number(weight) <= 1 ? Math.round(Number(weight) * 100) : Math.round(Number(weight))}% weight`);
  return pieces.length ? pieces.join(" · ") : JSON.stringify(value);
}

function getResourceExplanation(resource, explicitMatch) {
  const match = explicitMatch || resource?.match || {};
  const explanation = resource?.explanation || match?.explanation || {};
  const why = resource?.why || match?.why || (typeof explanation === "string" ? explanation : explanation?.why) || "Ranked from capability, location, cost, availability, verification, and trust signals.";
  const contributions = match?.contributions || resource?.contributions;
  const weights = match?.weights || resource?.weights;
  const weightedContributions = contributions && typeof contributions === "object"
    ? Object.fromEntries(Object.entries(contributions).map(([factor, contribution]) => [factor, { contribution, weight: weights?.[factor] }]))
    : null;
  const breakdown = weightedContributions || match?.breakdown || (typeof explanation === "object" ? explanation?.breakdown : {}) || resource?.breakdown || {};
  const score = match?.score ?? resource?.score ?? resource?.semanticScore ?? resource?.matchScore ?? 0;
  return { why, breakdown, score: Number(score) || 0 };
}

function explanationHtml(resource, explicitMatch) {
  const explanation = getResourceExplanation(resource, explicitMatch);
  const rows = breakdownRows(explanation.breakdown);
  return `
    <p class="match-why">${escapeHtml(explanation.why)}</p>
    ${rows ? `<details class="score-details"><summary>Score factors</summary><div class="match-breakdown">${rows}</div></details>` : ""}
  `;
}

function renderMatchResults(serverResults) {
  const results = document.getElementById("matchResults");
  const sortInput = document.getElementById("sortInput");
  if (!results) return;
  const query = {
    resourceType: document.getElementById("resourceType")?.value,
    cluster: document.getElementById("clusterInput")?.value,
    budget: Number(document.getElementById("budgetInput")?.value) || 999999,
    deadline: document.getElementById("deadlineInput")?.value,
    search: document.getElementById("searchInput")?.value,
  };
  let scored = serverResults;
  if (!scored) {
    scored = getFilteredResources().map((resource) => ({ ...resource, match: scoreMatch(resource, query) }));
    scored.sort((a, b) => {
      if (sortInput?.value === "price") return a.pricePerDay - b.pricePerDay;
      if (sortInput?.value === "rating") return b.rating - a.rating;
      return b.match.score - a.match.score;
    });
  }
  if (!scored.length) {
    results.innerHTML = '<div class="result-card">No matching resources found. Adjust your criteria or list a new resource.</div>';
    return;
  }
  results.innerHTML = scored.map((resource) => {
    const matchInfo = getResourceExplanation(resource);
    const bookable = Boolean(resource.verified && resource.availability);
    const bookingStatus = !resource.verified ? "Awaiting verification" : "Currently unavailable";
    return `
    <div class="result-card">
      <div class="result-head">
        <div>
          <strong>${escapeHtml(resource.name)}</strong>
          <div class="muted">${escapeHtml(resource.category)} · ${escapeHtml(resource.cluster)} · trust ${escapeHtml(resource.trustScore ?? "—")}</div>
          <div class="muted">${escapeHtml(resource.description)}</div>
        </div>
        <div>
          <span class="badge ${resource.verified ? "verified" : "unverified"}">${resource.verified ? "Verified" : "Unverified"}</span>
          <div class="muted">★ ${escapeHtml(resource.rating)}</div>
        </div>
      </div>
      <div class="score-meter">
        <div>Match score: <strong>${escapeHtml(matchInfo.score)}%</strong></div>
        <div class="score-fill" style="width:${Math.max(0, Math.min(100, matchInfo.score))}%"></div>
        ${explanationHtml(resource)}
      </div>
      <div class="result-head" style="margin-top:10px;">
        <div><strong>₹${escapeHtml(resource.pricePerDay)}</strong>/day</div>
        ${state.currentRole === "buyer" && bookable ? `<div>
          <button class="secondary" data-add-cart="${escapeHtml(resource.id)}" type="button">Add to cart</button>
          <button class="primary" data-quick-book="${escapeHtml(resource.id)}" type="button">Quick book</button>
        </div>` : state.currentRole === "buyer" ? `<span class="pill">${escapeHtml(bookingStatus)}</span>` : ""}
      </div>
    </div>
  `;
  }).join("");
}

async function runServerMatch() {
  const payload = {
    resourceType: document.getElementById("resourceType")?.value,
    cluster: document.getElementById("clusterInput")?.value,
    budget: Number(document.getElementById("budgetInput")?.value) || 999999,
    deadline: document.getElementById("deadlineInput")?.value,
    search: document.getElementById("searchInput")?.value || document.getElementById("nlMatchInput")?.value,
    sort: document.getElementById("sortInput")?.value,
    verifiedOnly: state.verifiedOnly,
    availableOnly: state.availableOnly,
  };
  try {
    const data = await fetchJson("/api/match", { method: "POST", body: JSON.stringify(payload) });
    renderMatchResults(data.results || []);
    if (data.engine?.label) {
      const chip = document.getElementById("engineChip");
      if (chip) chip.textContent = data.engine.label;
    }
  } catch {
    renderMatchResults();
  }
}

function renderMap() {
  const map = document.getElementById("mapVisual");
  if (!map) return;
  const directoryClusters = state.clusters.length
    ? state.clusters
    : [...new Set(state.resources.map((resource) => resource.cluster))].map((name) => ({ name, city: "" }));
  const known = new Set(directoryClusters.map((cluster) => cluster.name));
  const clusters = [
    ...directoryClusters,
    ...state.resources.filter((resource) => !known.has(resource.cluster)).map((resource) => ({ name: resource.cluster, city: "" })),
  ];
  const active = state.clusterFilter || document.getElementById("clusterInput")?.value || "";
  map.innerHTML = clusters.map((cluster) => {
    const count = state.resources.filter((r) => r.cluster === cluster.name).length;
    const city = cluster.city ? ` · ${cluster.city}` : "";
    return `<button class="cluster-node ${cluster.name === active ? "active" : ""}" data-cluster="${escapeHtml(cluster.name)}" type="button">${escapeHtml(cluster.name)}<br><span>${count} resources${escapeHtml(city)}</span></button>`;
  }).join("");
}

function renderAdminQueue() {
  const adminQueue = document.getElementById("adminQueue");
  if (!adminQueue) return;
  const pending = state.resources.filter((r) => !r.verified);
  if (!pending.length) {
    adminQueue.innerHTML = '<div class="result-card">No pending reviews. Network is current.</div>';
    return;
  }
  adminQueue.innerHTML = pending.map((resource) => `
    <div class="result-card">
      <div class="result-head">
        <div>
          <strong>${escapeHtml(resource.name)}</strong>
          <div class="muted">${escapeHtml(resource.category)} · ${escapeHtml(resource.cluster)}</div>
        </div>
        <span class="badge pending">Pending verification</span>
      </div>
      <div class="muted">${escapeHtml(resource.description)}</div>
      <div style="margin-top:10px; display:flex; gap:8px;">
        <button class="primary" data-approve="${escapeHtml(resource.id)}" type="button">Approve</button>
        <button class="secondary" data-reject="${escapeHtml(resource.id)}" type="button">Reject</button>
      </div>
    </div>
  `).join("");
}

function renderOwnerListings() {
  const ownerListings = document.getElementById("ownerListings");
  if (!ownerListings) return;
  const ownerResources = state.resources.filter((r) => r.ownerId === getCurrentOwnerId());
  if (!ownerResources.length) {
    ownerListings.innerHTML = '<div class="result-card">You have not listed resources yet. Use the form above to add one.</div>';
    return;
  }
  ownerListings.innerHTML = ownerResources.map((resource) => `
    <div class="result-card">
      <div class="result-head">
        <div>
          <strong>${escapeHtml(resource.name)}</strong>
          <div class="muted">${escapeHtml(resource.cluster)} · ₹${escapeHtml(resource.pricePerDay)}/day</div>
        </div>
        <span class="badge ${resource.verified ? "verified" : "unverified"}">${resource.verified ? "Verified" : "Unverified"}</span>
      </div>
      <div class="muted">Availability <strong>${resource.availability ? "Open" : "Paused"}</strong></div>
      <div style="margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <label style="min-width:140px;">Price<input data-edit-price="${escapeHtml(resource.id)}" type="number" value="${escapeHtml(resource.pricePerDay)}" /></label>
        <label class="checkbox-label"><input data-toggle-avail="${escapeHtml(resource.id)}" type="checkbox" ${resource.availability ? "checked" : ""} /> Available</label>
        <button class="secondary" data-remove-resource="${escapeHtml(resource.id)}" type="button">Remove</button>
      </div>
    </div>
  `).join("");
}

function renderBookingOptions() {
  const select = document.getElementById("quickBookingSelect");
  if (!select) return;
  const verifiedResources = state.resources.filter((r) => r.verified && r.availability);
  const bookableIds = new Set(verifiedResources.map((resource) => resource.id));
  state.cart = state.cart.filter((resourceId) => bookableIds.has(resourceId));
  select.innerHTML = ["<option value=\"\">Choose a resource</option>"]
    .concat(verifiedResources.map((resource) => `<option value="${escapeHtml(resource.id)}">${escapeHtml(resource.name)} — ₹${escapeHtml(resource.pricePerDay)}/day</option>`))
    .join("");
  const quickBookButton = document.getElementById("quickBookBtn");
  if (quickBookButton) quickBookButton.disabled = !verifiedResources.length || !select.value;
  const cartList = document.getElementById("cartList");
  const submitBundleButton = document.getElementById("submitBundleBtn");
  if (submitBundleButton) submitBundleButton.disabled = !state.cart.length;
  if (!cartList) return;
  if (!state.cart.length) {
    cartList.innerHTML = '<div class="cart-item">Your bundle is empty. Add a few resources from the match results.</div>';
    return;
  }
  cartList.innerHTML = state.cart.map((resourceId) => {
    const resource = state.resources.find((r) => r.id === resourceId);
    return `<div class="cart-item">${escapeHtml(resource?.name || resourceId)} — ₹${escapeHtml(resource?.pricePerDay || 0)}/day</div>`;
  }).join("");
}

function renderBookings() {
  const history = document.getElementById("bookingHistory");
  if (!history) return;
  if (!state.bookings.length) {
    history.innerHTML = '<div class="result-card">No booking history yet.</div>';
    return;
  }
  history.innerHTML = state.bookings.map((booking) => {
    const resourceNames = (booking.resources || []).map((rid) => state.resources.find((r) => r.id === rid)?.name || rid).join(", ");
    return `
      <div class="result-card">
        <div class="result-head">
          <div>
            <strong>${escapeHtml(booking.id)}</strong>
            <div class="muted">${escapeHtml(resourceNames)}</div>
          </div>
          <span class="badge ${booking.status === "Completed" ? "verified" : "pending"}">${escapeHtml(booking.status)}</span>
        </div>
        <div class="muted">Buyer: ${escapeHtml(booking.buyer)} · Total: ₹${escapeHtml(booking.total)} · Created: ${escapeHtml(booking.created)}</div>
        <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
          ${booking.status !== "Completed" ? `<button class="primary" data-complete-booking="${escapeHtml(booking.id)}" type="button">Mark complete</button>` : ""}
          ${booking.status === "Completed" && booking.rating == null ? `<label>Rate this delivery<input data-rate-booking="${escapeHtml(booking.id)}" type="number" min="1" max="5" value="5" /></label>` : ""}
        </div>
      </div>
    `;
  }).join("");
}

function renderAnalytics() {
  const categoryChart = document.getElementById("categoryChart");
  const trendChart = document.getElementById("trendChart");
  if (!categoryChart || !trendChart) return;
  const {
    categories = [], listed = [], demand = [], trendLabels = [], trend = [],
    trendPeriods = [], carbonSavings = 0, carbonBreakdown = {}, assumptions = {},
  } = state.analytics;
  categoryChart.innerHTML = categories.map((cat, index) => `
    <div class="chart-column">
      <div class="bar listed-bar" style="height:${Math.max(35, listed[index] * 22)}px" title="Listed: ${listed[index]}"><span>${listed[index]}</span></div>
      <div class="bar demand-bar" style="height:${Math.max(35, demand[index] * 22)}px" title="Demand: ${demand[index]}"><span>${demand[index]}</span></div>
      <div class="chart-label">${escapeHtml(cat)}</div>
    </div>
  `).join("");
  trendChart.innerHTML = trendLabels.map((month, index) => `
    <div class="chart-column">
      <div class="bar trend-bar" style="height:${Math.max(35, trend[index] * 28)}px" title="Bookings in ${escapeHtml(trendPeriods[index] || month)}: ${trend[index]}"><span>${trend[index]}</span></div>
      <div class="chart-label">${escapeHtml(month)}${trendPeriods[index] ? `<small>${escapeHtml(trendPeriods[index].slice(0, 4))}</small>` : ""}</div>
    </div>
  `).join("");

  const impactValue = document.getElementById("carbonImpactValue");
  const impactMetrics = document.getElementById("carbonImpactMetrics");
  const impactMethod = document.getElementById("carbonImpactMethod");
  if (!impactValue || !impactMetrics || !impactMethod) return;
  const completed = Number(carbonBreakdown.bookingCount) || 0;
  const gross = Number(carbonBreakdown.grossAvoidedKg) || 0;
  const freight = Number(carbonBreakdown.transportEmissionsKg) || 0;
  const utilization = Number(carbonBreakdown.averageUtilizationPercent) || 0;
  const distanceProxy = (Array.isArray(carbonBreakdown.byCategory) ? carbonBreakdown.byCategory : [])
    .reduce((sum, category) => sum + (Number(category.distanceProxyKm) || 0), 0);
  const projected = Number(carbonBreakdown.projectedActive?.netSavedKg) || 0;
  impactValue.textContent = `${Number(carbonSavings).toFixed(1)} kgCO2e`;
  impactMetrics.innerHTML = [
    ["Completed bookings", completed],
    ["Gross sharing credit", `${gross.toFixed(1)} kg`],
    ["Freight deduction", `${freight.toFixed(1)} kg`],
    ["Average utilization", `${utilization.toFixed(1)}%`],
    ["Distance proxy", `${distanceProxy.toFixed(1)} km`],
    ["Active projection", `${projected.toFixed(1)} kg`],
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  const carbonAssumptions = assumptions.carbonSavings || {};
  impactMethod.textContent = carbonAssumptions.caveat
    ? `${carbonAssumptions.caveat} Distance is an estimated cost-derived proxy, not observed travel.`
    : "Planning estimate only; distance is a cost-derived proxy, not observed travel.";
}

async function submitResource() {
  const payload = {
    name: document.getElementById("listName").value,
    category: document.getElementById("listCategory").value,
    cluster: document.getElementById("listCluster").value,
    pricePerDay: Number(document.getElementById("listPrice").value),
    ownerId: getCurrentOwnerId(),
    ownerName: state.user?.name || state.user?.username || "Current MSME",
    description: document.getElementById("listDescription").value,
    tags: [document.getElementById("listCategory").value.toLowerCase(), document.getElementById("listCluster").value.toLowerCase()],
  };
  await fetchJson("/api/resources", { method: "POST", body: JSON.stringify(payload) });
  await Promise.all([loadResources(), loadDashboard(), loadNotifications(), loadAnalytics()]);
  toast("Listing submitted for verification");
  render();
}

async function patchResource(resourceId, updates) {
  await fetchJson(`/api/resources/${resourceId}`, { method: "PATCH", body: JSON.stringify(updates) });
  await Promise.all([loadResources(), loadDashboard(), loadNotifications(), loadAnalytics()]);
  render();
}

async function removeResource(resourceId) {
  await fetchJson(`/api/resources/${resourceId}`, { method: "DELETE" });
  await Promise.all([loadResources(), loadDashboard(), loadNotifications(), loadAnalytics()]);
  render();
}

async function submitBooking(resourceIds, buyerName = "Demo Buyer") {
  const blocked = resourceIds
    .map((resourceId) => state.resources.find((resource) => resource.id === resourceId))
    .find((resource) => !resource || !resource.verified || !resource.availability);
  if (blocked) {
    toast("That resource is not currently verified and available. Refreshing catalogue.");
    await loadResources();
    render();
    return;
  }
  const sessionBuyer = state.user?.name || state.user?.username || buyerName;
  await fetchJson("/api/bookings", { method: "POST", body: JSON.stringify({ resourceIds, buyer: sessionBuyer }) });
  await Promise.all([loadBookings(), loadResources(), loadDashboard(), loadNotifications(), loadAnalytics()]);
  state.cart = [];
  toast("Booking request submitted");
  render();
}

async function updateBookingStatus(bookingId, action, rating) {
  await fetchJson(`/api/bookings/${bookingId}`, { method: "PATCH", body: JSON.stringify({ action, rating }) });
  await Promise.all([loadBookings(), loadResources(), loadDashboard(), loadNotifications(), loadAnalytics()]);
  render();
}

function addBookingToCart(resourceId) {
  const resource = state.resources.find((item) => item.id === resourceId);
  if (!resource?.verified || !resource?.availability) {
    toast("Only verified, available resources can be added to a booking.");
    return;
  }
  if (!state.cart.includes(resourceId)) {
    state.cart.push(resourceId);
    toast("Added to bundle cart");
  }
}

function appendCopilotMessage(role, text, matches = []) {
  const thread = document.getElementById("copilotThread");
  if (!thread) return;
  const wrap = document.createElement("div");
  wrap.className = `copilot-msg ${role}`;
  wrap.innerHTML = `<div>${escapeHtml(text)}</div>${matches.length ? `<div class="muted">${matches.map((m) => escapeHtml(`${m.name} · ${m.cluster} · ${m.semanticScore}%`)).join("<br>")}</div>` : ""}`;
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
}

function applyAiActions(actions = []) {
  actions.forEach((action) => {
    if (action.type === "set_filters") {
      const filters = action.filters || {};
      if (filters.cluster) {
        document.getElementById("clusterInput").value = filters.cluster;
        state.clusterFilter = filters.cluster;
      }
      if (filters.resourceType) {
        const select = document.getElementById("resourceType");
        if ([...select.options].some((item) => item.value === filters.resourceType)) select.value = filters.resourceType;
      }
      if (filters.budget) document.getElementById("budgetInput").value = filters.budget;
      if (filters.search) document.getElementById("searchInput").value = filters.search;
      state.verifiedOnly = Boolean(filters.verifiedOnly);
      state.availableOnly = Boolean(filters.availableOnly);
      const verified = document.getElementById("verifiedOnly");
      const available = document.getElementById("availableOnly");
      if (verified) verified.checked = state.verifiedOnly;
      if (available) available.checked = state.availableOnly;
      setView("match");
      renderMatchResults();
    }
    if (action.type === "open_planner") {
      const payload = action.payload || {};
      document.getElementById("productName").value = payload.productName || "AI parsed job";
      document.getElementById("productQuantity").value = payload.quantity || 500;
      document.getElementById("productMaterial").value = payload.material || "Aluminium";
      document.getElementById("productProcesses").value = payload.processes || "CNC Machining";
      document.getElementById("productDeadline").value = payload.deadline || 7;
      document.getElementById("productBudget").value = payload.budget || 80000;
      document.getElementById("productCluster").value = payload.cluster || "";
      document.getElementById("productQuality").value = payload.quality || "Standard";
      setView("planner");
    }
    if (action.type === "open_view" && action.view) setView(action.view);
  });
}

async function sendCopilot(message) {
  if (!message.trim()) return;
  appendCopilotMessage("user", message);
  try {
    const data = await fetchJson("/api/ai/chat", { method: "POST", body: JSON.stringify({ message }) });
    appendCopilotMessage("assistant", data.reply || "No reply", data.matches || []);
    applyAiActions(data.actions || []);
    if (data.engine?.label) {
      document.getElementById("copilotEngine").textContent = data.engine.label;
      document.getElementById("engineChip").textContent = data.engine.label;
    }
  } catch (error) {
    appendCopilotMessage("assistant", error.message || "Copilot is unavailable right now.");
  }
}

async function parseNaturalLanguageIntoMatch() {
  const text = document.getElementById("nlMatchInput")?.value;
  if (!text) return;
  const parsed = await fetchJson("/api/ai/parse", { method: "POST", body: JSON.stringify({ text }) });
  applyAiActions([{ type: "set_filters", filters: {
    cluster: parsed.cluster || parsed.entities?.cluster,
    resourceType: parsed.entities?.category,
    budget: parsed.budget || parsed.entities?.budget,
    search: text,
    verifiedOnly: parsed.entities?.verifiedOnly,
    availableOnly: parsed.entities?.availableOnly,
  } }]);
  toast("Filters filled from natural language");
  await runServerMatch();
}

async function fillPlannerFromNl() {
  const text = document.getElementById("plannerNl")?.value;
  if (!text) return;
  const parsed = await fetchJson("/api/ai/parse", { method: "POST", body: JSON.stringify({ text }) });
  applyAiActions([{ type: "open_planner", payload: parsed }]);
  toast("Planner filled from AI parse");
}

async function signIn(event) {
  event.preventDefault();
  const usernameInput = document.getElementById("loginUsername");
  const passwordInput = document.getElementById("loginPassword");
  const submit = document.getElementById("loginSubmit");
  const error = document.getElementById("loginError");
  const username = usernameInput?.value.trim() || "";
  const password = passwordInput?.value || "";
  if (!username || !password) return;
  if (error) error.hidden = true;
  if (submit) {
    submit.disabled = true;
    submit.textContent = "Signing in…";
  }
  try {
    const data = await fetchJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      suppressAuth: true,
    });
    if (!data.user) throw new ApiError("The server did not return an account session.", 500, data);
    applyAuthenticatedSession(data.user);
    await initializeWorkspace();
    toast(`Signed in as ${data.user.name || data.user.username}`);
  } catch (loginFailure) {
    requireAuthentication();
    if (error) {
      error.textContent = loginFailure.message || "Sign-in failed. Check the demo credentials.";
      error.hidden = false;
    }
    passwordInput?.focus();
    passwordInput?.select();
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = "Sign in";
    }
  }
}

async function signOut() {
  const button = document.getElementById("logoutBtn");
  if (button) button.disabled = true;
  closeLiveEvents();
  stopAllVoiceInput();
  try {
    await fetchJson("/api/auth/logout", { method: "POST", body: JSON.stringify({}), suppressAuth: true });
  } catch {
    /* Clearing the local workspace is still correct if the server session already expired. */
  } finally {
    if (button) button.disabled = false;
    state.resources = [];
    state.bookings = [];
    state.notifications = [];
    state.cart = [];
    requireAuthentication();
  }
}

const composeControllers = new Map();
const fieldRevisions = new Map();
let copilotWorker = null;

const COMPOSE_CONFIGS = [
  {
    source: "search",
    inputId: "nlMatchInput",
    panelId: "searchComposePanel",
    fields: [
      { semantic: "resourceType", target: "resourceType", aliases: ["resourceType", "resource_type", "category", "type"] },
      { semantic: "cluster", target: "clusterInput", aliases: ["cluster", "location", "city", "preferred_cluster"] },
      { semantic: "budget", target: "budgetInput", aliases: ["budget", "max_price", "price", "pricePerDay", "daily_budget"] },
      { semantic: "deadline", target: "deadlineInput", aliases: ["deadline", "date", "needed_by", "deadline_days"] },
      { semantic: "search", target: "searchInput", aliases: ["search", "query", "capability", "process"] },
      { semantic: "verifiedOnly", target: "verifiedOnly", aliases: ["verifiedOnly", "verified_only", "verified"] },
      { semantic: "availableOnly", target: "availableOnly", aliases: ["availableOnly", "available_only", "availability", "available"] },
    ],
  },
  {
    source: "planner",
    inputId: "plannerNl",
    panelId: "plannerComposePanel",
    fields: [
      { semantic: "productName", target: "productName", aliases: ["productName", "product_name", "product", "job"] },
      { semantic: "quantity", target: "productQuantity", aliases: ["quantity", "units", "volume"] },
      { semantic: "material", target: "productMaterial", aliases: ["material", "substrate"] },
      { semantic: "processes", target: "productProcesses", aliases: ["processes", "process", "capabilities", "capability", "operations"] },
      { semantic: "deadline", target: "productDeadline", aliases: ["deadline", "deadline_days", "days", "lead_time"] },
      { semantic: "budget", target: "productBudget", aliases: ["budget", "max_cost", "price"] },
      { semantic: "cluster", target: "productCluster", aliases: ["cluster", "location", "city", "preferred_cluster"] },
      { semantic: "quality", target: "productQuality", aliases: ["quality", "quality_requirement", "tolerance"] },
    ],
  },
  {
    source: "listing",
    inputId: "listingNl",
    panelId: "listingComposePanel",
    fields: [
      { semantic: "name", target: "listName", aliases: ["name", "resourceName", "resource_name", "resource", "equipment"] },
      { semantic: "category", target: "listCategory", aliases: ["category", "resourceType", "resource_type", "type"] },
      { semantic: "cluster", target: "listCluster", aliases: ["cluster", "location", "city"] },
      { semantic: "pricePerDay", target: "listPrice", aliases: ["pricePerDay", "price_per_day", "price", "daily_rate", "budget"] },
      { semantic: "description", target: "listDescription", aliases: ["description", "details", "capability", "capabilities"] },
    ],
  },
];

function normalizedFieldKey(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function fieldRevision(id) {
  return fieldRevisions.get(id) || 0;
}

function trackComposeTargetFields() {
  const ids = new Set(COMPOSE_CONFIGS.flatMap((config) => config.fields.map((field) => field.target)));
  ids.forEach((id) => {
    const element = document.getElementById(id);
    if (!element || element.dataset.composeRevisionTracked === "true") return;
    element.dataset.composeRevisionTracked = "true";
    fieldRevisions.set(id, 0);
    element.addEventListener("input", () => fieldRevisions.set(id, fieldRevision(id) + 1));
    element.addEventListener("change", () => fieldRevisions.set(id, fieldRevision(id) + 1));
  });
}

function initializeCompose() {
  if (composeControllers.size) return;
  trackComposeTargetFields();
  try {
    copilotWorker = new Worker("/copilot-worker.js", { type: "module" });
    copilotWorker.addEventListener("message", (event) => {
      composeControllers.forEach((controller) => controller.handleWorkerMessage(event.data || {}));
      if (event.data?.type === "model-status" && event.data.status === "ready") {
        const chip = document.getElementById("engineChip");
        if (chip && !chip.textContent.includes("cloud")) chip.textContent = "Local Compose · WebGPU/WASM";
      }
    });
    copilotWorker.addEventListener("error", () => {
      copilotWorker?.terminate();
      copilotWorker = null;
    });
  } catch {
    copilotWorker = null;
  }
  COMPOSE_CONFIGS.forEach((config) => {
    if (document.getElementById(config.inputId) && document.getElementById(config.panelId)) {
      composeControllers.set(config.source, new ComposeController(config));
    }
  });
}

function canUseCompose() {
  return state.authenticated && (state.currentRole === "buyer" || state.currentRole === "owner");
}

function updateComposeAvailability() {
  composeControllers.forEach((controller) => controller.updateAvailability());
}

function cancelAllCompose() {
  composeControllers.forEach((controller) => controller.cancel(true));
}

function resetCompose(source) {
  const controller = composeControllers.get(source);
  if (!controller) return;
  controller.cancel(true);
  controller.config.fields.forEach((field) => {
    fieldRevisions.set(field.target, fieldRevision(field.target) + 1);
  });
}

function normalizeConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric > 1 ? numeric / 100 : numeric));
}

function normalizeExtractedFields(fields = {}) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return [];
  return Object.entries(fields).flatMap(([key, candidate]) => {
    const wrapped = candidate && typeof candidate === "object" && !Array.isArray(candidate) && Object.hasOwn(candidate, "value");
    const value = wrapped ? candidate.value : candidate;
    const confidence = normalizeConfidence(wrapped ? candidate.confidence : 0);
    if (value == null || value === "") return [];
    return [{ key, value, confidence }];
  });
}

function completionSuffixFor(text, completion) {
  const value = String(completion || "").replace(/^\s*<\|.*?\|>\s*/g, "");
  if (!value) return "";
  if (value.toLowerCase().startsWith(text.toLowerCase())) return value.slice(text.length).slice(0, 220);
  return value.slice(0, 220);
}

function composeEngineLabel(engine) {
  if (typeof engine === "string") return engine;
  return engine?.label || engine?.name || engine?.provider || "FREP local engine";
}

function elementSnapshot(config) {
  const fields = {};
  const revisions = {};
  config.fields.forEach((field) => {
    const element = document.getElementById(field.target);
    if (!element) return;
    fields[field.semantic] = element.type === "checkbox" ? element.checked : element.value;
    revisions[field.target] = fieldRevision(field.target);
  });
  return { fields, revisions };
}

function ruleForCandidate(config, key) {
  const normalized = normalizedFieldKey(key);
  return config.fields.find((rule) => rule.aliases.some((alias) => normalizedFieldKey(alias) === normalized));
}

function matchingSelectValue(select, value, semantic, source) {
  const wanted = normalizeString(value);
  const exact = [...select.options].find((option) => normalizeString(option.value) === wanted || normalizeString(option.textContent) === wanted);
  if (exact) return exact.value;
  const domainValue = normalizeString(value);
  const categoryHint = /warehouse|storage/.test(domainValue) ? "Warehouse Space"
    : /test|inspect|quality|cmm|lab/.test(domainValue) ? "Testing Equipment"
      : /operator|labou?r|technician|welder/.test(domainValue) ? "Skilled Operator"
        : /logistic|truck|vehicle|transport|forklift/.test(domainValue) ? "Logistics Vehicle"
          : /cnc|lathe|mill|machine|vmc|machinery/.test(domainValue) ? (source === "listing" ? "Machinery" : "CNC Lathe")
            : "";
  if (!categoryHint || !["category", "resourceType"].includes(semantic)) return "";
  return [...select.options].some((option) => option.value === categoryHint) ? categoryHint : "";
}

function coerceComposeValue(element, value, semantic, source) {
  if (Array.isArray(value)) value = value.join(", ");
  if (element.type === "checkbox") {
    if (typeof value === "boolean") return value;
    return /^(true|yes|1|verified|available)$/i.test(String(value));
  }
  if (element.tagName === "SELECT") return matchingSelectValue(element, value, semantic, source);
  if (element.type === "date") {
    const direct = String(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (direct) return direct;
    const days = Number(String(value).match(/\d+/)?.[0]);
    if (Number.isFinite(days) && days > 0) {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date.toISOString().slice(0, 10);
    }
    return "";
  }
  if (element.type === "number") {
    if (semantic === "deadline" && /^\d{4}-\d{2}-\d{2}/.test(String(value))) {
      return Math.max(1, Math.ceil((new Date(value) - new Date()) / 86400000));
    }
    const numeric = Number(String(value).replace(/[^\d.-]/g, ""));
    return Number.isFinite(numeric) ? numeric : "";
  }
  return String(value);
}

class ComposeController {
  constructor(config) {
    this.config = config;
    this.input = document.getElementById(config.inputId);
    this.panel = document.getElementById(config.panelId);
    this.control = this.input.closest(".compose-control");
    this.ghost = this.control?.querySelector(".compose-ghost");
    this.prefix = this.control?.querySelector("[data-compose-prefix]");
    this.suffixElement = this.control?.querySelector("[data-compose-suffix]");
    this.timer = null;
    this.abortController = null;
    this.cloudAbortController = null;
    this.sequence = 0;
    this.suffix = "";
    this.completionTier = 0;
    this.workerRequestId = "";
    this.latest = null;
    this.serverReceived = false;
    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (event) => this.onKeydown(event));
    this.input.addEventListener("scroll", () => this.syncGhostScroll());
    this.panel.addEventListener("click", (event) => {
      const apply = event.target.closest("[data-compose-apply]");
      if (apply) this.applyFields(true);
    });
  }

  updateAvailability() {
    if (!state.authenticated) {
      this.panel.hidden = true;
      return;
    }
    if (!canUseCompose()) {
      this.cancel(false);
      this.panel.hidden = false;
      this.panel.classList.remove("loading");
      this.panel.innerHTML = '<p class="compose-unavailable">Live Compose is available to Buyer and Resource Owner accounts. Admin suggestions are disabled by policy.</p>';
      return;
    }
    if (!this.input.value.trim()) this.panel.hidden = true;
  }

  schedule() {
    this.cancelPendingRequest();
    this.clearCompletion();
    this.completionTier = 0;
    this.latest = null;
    this.serverReceived = false;
    const text = this.input.value;
    if (!canUseCompose()) {
      this.updateAvailability();
      return;
    }
    if (text.trim().length < 2) {
      this.panel.hidden = true;
      return;
    }
    this.panel.hidden = true;
    const sequence = ++this.sequence;
    this.timer = window.setTimeout(() => this.request(text, sequence), 300);
  }

  cancelPendingRequest() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    this.abortController?.abort();
    this.abortController = null;
    this.cloudAbortController?.abort();
    this.cloudAbortController = null;
  }

  cancel(hidePanel = false) {
    this.cancelPendingRequest();
    this.sequence += 1;
    this.clearCompletion();
    this.completionTier = 0;
    this.latest = null;
    if (hidePanel) {
      this.panel.hidden = true;
      this.panel.innerHTML = "";
    }
  }

  async request(text, sequence) {
    if (sequence !== this.sequence || text !== this.input.value || !canUseCompose()) return;
    const snapshot = elementSnapshot(this.config);
    this.abortController = new AbortController();
    this.workerRequestId = `${this.config.source}:${sequence}:${Date.now()}`;
    this.panel.hidden = false;
    this.panel.classList.add("loading");
    this.panel.innerHTML = '<div class="compose-panel-head"><strong>Live Compose</strong><span class="compose-status">Finding grounded suggestions…</span></div>';
    try {
      copilotWorker?.postMessage({
        type: "suggest",
        id: this.workerRequestId,
        text,
        source: this.config.source,
        context: snapshot.fields,
      });
    } catch {
      /* The server request below remains fully functional without the worker. */
    }
    try {
      const data = await fetchJson("/api/copilot/typeahead", {
        method: "POST",
        body: JSON.stringify({ text, role: state.currentRole, context: { source: this.config.source, fields: snapshot.fields, form: snapshot.fields } }),
        signal: this.abortController.signal,
      });
      if (sequence !== this.sequence || text !== this.input.value) return;
      this.serverReceived = true;
      const normalizedFields = normalizeExtractedFields(data.fields);
      this.latest = { data, normalizedFields, snapshot, sequence, text, applied: new Set() };
      this.completionTier = 1;
      this.setCompletion(data.completion, text);
      this.applyFields(false);
      this.renderPanel();
      if (data.engine?.cloudEnabled) void this.requestCloudEnhancement(text, sequence, snapshot);
    } catch (error) {
      if (error?.name === "AbortError" || sequence !== this.sequence) return;
      if (error?.status === 403) {
        this.panel.innerHTML = '<p class="compose-unavailable">Compose is not enabled for this role.</p>';
      } else {
        this.panel.innerHTML = '<div class="compose-panel-head"><strong>Local completion active</strong><span class="compose-status">Grounded matches unavailable</span></div><p class="compose-unavailable">Keep typing or retry; the worker fallback remains available without a paid key.</p>';
      }
    } finally {
      if (sequence === this.sequence) {
        this.panel.classList.remove("loading");
        this.abortController = null;
      }
    }
  }

  async requestCloudEnhancement(text, sequence, snapshot) {
    const controller = new AbortController();
    this.cloudAbortController?.abort();
    this.cloudAbortController = controller;
    let completion = "";
    let engine = "cloud";
    const promote = (nextCompletion, rerender = false) => {
      if (sequence !== this.sequence || text !== this.input.value || controller.signal.aborted || !nextCompletion.trim()) return;
      completion = nextCompletion.slice(0, 220);
      this.completionTier = 3;
      this.setCompletion(completion, text);
      if (this.latest?.data) {
        this.latest.data = {
          ...this.latest.data,
          completion,
          engine: {
            label: `${engine === "hybrid-gemini" ? "Gemini" : "Groq"} streaming upgrade`,
            mode: engine,
            cloudEnabled: true,
          },
        };
        if (rerender) this.renderPanel();
      }
    };
    const consumeEvent = (block) => {
      const lines = block.split("\n");
      const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
      const payloadText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!payloadText) return;
      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        return;
      }
      if (payload.engine) engine = payload.engine;
      if (eventName === "token" && payload.token) promote(completion + payload.token);
      if (eventName === "complete" && payload.completion) promote(payload.completion, true);
    };
    try {
      const response = await fetch("/api/copilot/typeahead/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          text,
          context: { source: this.config.source, fields: snapshot.fields, form: snapshot.fields },
        }),
        signal: controller.signal,
      });
      if (response.status === 204 || !response.body) return;
      if (!response.ok) throw new Error(`Cloud Compose returned ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          consumeEvent(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
      if (buffer.trim()) consumeEvent(buffer);
      if (completion) promote(completion, true);
    } catch (error) {
      if (error?.name !== "AbortError") {
        // The local server/worker result stays visible on all provider errors.
      }
    } finally {
      if (this.cloudAbortController === controller) this.cloudAbortController = null;
    }
  }

  handleWorkerMessage(message) {
    if (!message || message.id !== this.workerRequestId || message.text !== this.input.value || !canUseCompose()) return;
    if (message.type === "suggestion" && this.completionTier < 1 && (!this.serverReceived || !this.suffix)) {
      this.setCompletion(message.completion, message.text);
    }
    if (message.type === "enhancement" && this.completionTier < 3) {
      // The transformer response is the highest-quality local tier. It may
      // arrive after the fast server response, so promote it only while this
      // request is still current (guarded above).
      this.completionTier = 2;
      this.setCompletion(message.completion, message.text);
      if (this.latest?.data) {
        this.latest.data = {
          ...this.latest.data,
          completion: message.completion,
          engine: {
            label: message.engine || "Browser transformer",
            mode: "browser-local",
            cloudEnabled: this.latest.data.engine?.cloudEnabled || false,
          },
        };
        this.renderPanel();
      }
    }
  }

  setCompletion(completion, text = this.input.value) {
    this.suffix = completionSuffixFor(text, completion);
    if (this.prefix) this.prefix.textContent = text;
    if (this.suffixElement) this.suffixElement.textContent = this.suffix;
    this.syncGhostScroll();
  }

  clearCompletion() {
    this.suffix = "";
    if (this.prefix) this.prefix.textContent = "";
    if (this.suffixElement) this.suffixElement.textContent = "";
  }

  syncGhostScroll() {
    if (!this.ghost) return;
    this.ghost.style.transform = `translate(${-this.input.scrollLeft}px, ${-this.input.scrollTop}px)`;
  }

  onKeydown(event) {
    if (event.key === "Escape" && (this.suffix || !this.panel.hidden)) {
      event.preventDefault();
      this.cancel(true);
      return;
    }
    const atEnd = this.input.selectionStart === this.input.value.length && this.input.selectionEnd === this.input.value.length;
    if (!this.suffix || !atEnd || (event.key !== "Tab" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const completion = this.suffix;
    this.clearCompletion();
    this.input.value += completion;
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  applyFields(explicit) {
    if (!this.latest) return;
    let appliedCount = 0;
    let skippedCount = 0;
    for (const candidate of this.latest.normalizedFields) {
      const rule = ruleForCandidate(this.config, candidate.key);
      if (!rule || candidate.confidence < (explicit ? 0.5 : 0.9)) continue;
      if (fieldRevision(rule.target) !== (this.latest.snapshot.revisions[rule.target] || 0)) {
        skippedCount += 1;
        continue;
      }
      const element = document.getElementById(rule.target);
      if (!element) continue;
      const value = coerceComposeValue(element, candidate.value, rule.semantic, this.config.source);
      if (value === "" && candidate.value !== "") continue;
      if (element.type === "checkbox") element.checked = Boolean(value);
      else element.value = value;
      this.latest.applied.add(candidate.key);
      appliedCount += 1;
    }
    if (appliedCount) this.afterApply();
    if (explicit) {
      const detail = skippedCount ? ` ${skippedCount} field${skippedCount === 1 ? " was" : "s were"} preserved because you edited ${skippedCount === 1 ? "it" : "them"}.` : "";
      toast(`${appliedCount ? `${appliedCount} observed field${appliedCount === 1 ? "" : "s"} applied.` : "No eligible fields to apply."}${detail}`);
      this.renderPanel();
    }
  }

  afterApply() {
    if (this.config.source === "search") {
      state.clusterFilter = document.getElementById("clusterInput")?.value.trim() || "";
      state.verifiedOnly = Boolean(document.getElementById("verifiedOnly")?.checked);
      state.availableOnly = Boolean(document.getElementById("availableOnly")?.checked);
      renderMatchResults();
      renderMap();
    }
    if (this.config.source === "planner") renderProcessSuggestions();
  }

  renderPanel() {
    if (!this.latest) return;
    const { data, normalizedFields, applied } = this.latest;
    const matches = (Array.isArray(data.matches) ? data.matches : []).slice(0, 3);
    const fieldsHtml = normalizedFields.map((field) => `
      <span class="confidence-chip" title="${escapeHtml(field.key)} confidence">
        ${escapeHtml(humanizeFactor(field.key))}: ${escapeHtml(Array.isArray(field.value) ? field.value.join(", ") : field.value)}
        <output>${Math.round(field.confidence * 100)}%</output>
      </span>
    `).join("");
    const matchesHtml = matches.map((resource) => {
      const match = getResourceExplanation(resource);
      const factors = breakdownRows(match.breakdown);
      return `
        <article class="compose-match">
          <div class="result-head"><strong>${escapeHtml(resource.name || "Resource")}</strong><span class="badge verified">${escapeHtml(match.score)}%</span></div>
          <div class="compose-match-meta">${escapeHtml(resource.category || "Capacity")} · ${escapeHtml(resource.cluster || "Any cluster")} ${resource.pricePerDay != null ? `· ₹${escapeHtml(resource.pricePerDay)}/day` : ""}</div>
          <p class="match-why">${escapeHtml(match.why)}</p>
          ${factors ? `<details class="score-details"><summary>Score factors</summary><div class="match-breakdown">${factors}</div></details>` : ""}
        </article>
      `;
    }).join("");
    const duration = data.durationMs ?? data.duration_ms;
    const engine = composeEngineLabel(data.engine);
    const suffix = completionSuffixFor(this.latest.text, data.completion);
    const autoApplied = applied.size ? `${applied.size} high-confidence field${applied.size === 1 ? "" : "s"} applied.` : "Your edits are always preserved.";
    this.panel.hidden = false;
    this.panel.innerHTML = `
      <div class="compose-panel-head">
        <strong>Live Compose</strong>
        <span class="compose-status">${escapeHtml(engine)}${duration != null ? ` · ${escapeHtml(Math.round(Number(duration)))} ms` : ""}</span>
      </div>
      ${suffix ? `<p class="compose-completion">Completion: <code>${escapeHtml(suffix)}</code></p>` : ""}
      ${fieldsHtml ? `<div class="compose-fields" aria-label="Observed fields">${fieldsHtml}</div>` : '<p class="compose-unavailable">No structured fields observed yet.</p>'}
      ${normalizedFields.length ? `<div class="compose-actions"><button class="secondary" data-compose-apply type="button">Apply fields</button><span class="compose-note">${escapeHtml(autoApplied)}</span></div>` : ""}
      ${matchesHtml ? `<div><span class="compose-note">Grounded top matches</span><div class="compose-matches">${matchesHtml}</div></div>` : '<p class="compose-unavailable">No grounded match yet; add a capability or location.</p>'}
    `;
  }
}

function actionDisplayValue(value) {
  if (value == null || value === "") return "Not specified";
  if (Array.isArray(value)) return value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ");
  if (typeof value === "object") return Object.entries(value)
    .map(([key, item]) => `${humanizeFactor(key)}: ${typeof item === "object" ? JSON.stringify(item) : item}`)
    .join(" · ");
  return String(value);
}

function normalizeActResponse(data = {}) {
  const draft = data.draft && typeof data.draft === "object" ? data.draft : {};
  const action = data.action && typeof data.action === "object"
    ? data.action
    : draft.action && typeof draft.action === "object"
      ? draft.action
      : draft;
  const matches = data.matches || data.groundedMatches || data.grounded_matches || draft.matches || [];
  return {
    raw: data,
    actionName: typeof data.action === "string" ? data.action : data.actionType || "proposedAction",
    confirmationToken: data.confirmationToken || data.confirmation_token || data.token || "",
    confirmable: data.confirmable !== false,
    requiresConfirmation: data.requiresConfirmation !== false && data.requires_confirmation !== false && data.action !== "searchResources",
    summary: data.summary || data.message || draft.summary || action.summary || "Review the proposed marketplace action.",
    action,
    matches: Array.isArray(matches) ? matches.slice(0, 3) : [],
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
    missingFields: Array.isArray(data.missingFields || data.missing_fields) ? (data.missingFields || data.missing_fields) : [],
  };
}

function clearActDraft() {
  state.actDraft = null;
  const draft = document.getElementById("actDraft");
  if (draft) {
    draft.hidden = true;
    draft.innerHTML = "";
  }
}

function renderActDraft() {
  const container = document.getElementById("actDraft");
  if (!container || !state.actDraft) return;
  const preview = state.actDraft;
  const reserved = new Set(["summary", "matches", "groundedMatches", "grounded_matches", "confirmationToken", "confirmation_token", "token"]);
  const rows = Object.entries(preview.action || {})
    .filter(([key]) => !reserved.has(key))
    .slice(0, 12)
    .map(([key, value]) => `<div class="act-field"><dt>${escapeHtml(humanizeFactor(key))}</dt><dd>${escapeHtml(actionDisplayValue(value))}</dd></div>`)
    .join("");
  const matches = preview.matches.map((match) => {
    const explanation = getResourceExplanation(match);
    return `
      <article class="act-match">
        <div class="result-head">
          <strong>${escapeHtml(match.name || match.resourceName || match.id || "Matched resource")}</strong>
          ${explanation.score ? `<span class="badge verified">${escapeHtml(explanation.score)}%</span>` : ""}
        </div>
        <div class="muted">${escapeHtml(match.cluster || match.location || "FREP network")}${match.pricePerDay != null ? ` · ₹${escapeHtml(match.pricePerDay)}/day` : ""}</div>
        ${explanation.why ? `<p class="match-why">${escapeHtml(explanation.why)}</p>` : ""}
      </article>
    `;
  }).join("");
  const canConfirm = Boolean(preview.confirmationToken && preview.confirmable);
  const warningText = [...preview.warnings, ...(preview.missingFields.length ? [`Missing: ${preview.missingFields.join(", ")}`] : [])].join(" ");
  container.hidden = false;
  container.innerHTML = `
    <div class="act-review-banner">
      <strong>Draft only — nothing has been written</strong>
      <span>${escapeHtml(humanizeFactor(preview.actionName))} · ${escapeHtml(preview.summary)}</span>
    </div>
    ${warningText ? `<div class="auth-error" role="alert">${escapeHtml(warningText)}</div>` : ""}
    ${rows ? `<dl class="act-fields">${rows}</dl>` : '<p class="muted">The server did not return structured action fields.</p>'}
    ${matches ? `<div class="act-matches"><strong>Grounded matches</strong>${matches}</div>` : ""}
    <div class="act-confirm-row">
      ${preview.requiresConfirmation ? `<button class="primary" id="actConfirmBtn" type="button" ${canConfirm ? "" : "disabled"}>Confirm action</button>` : '<span class="badge verified">Read-only result · no confirmation needed</span>'}
      <button class="ghost" id="actDiscardBtn" type="button">Discard</button>
    </div>
    ${preview.requiresConfirmation ? '<p class="act-safety-note">Confirm sends only the server-issued one-time token. Editing this display cannot alter the action.</p>' : ""}
  `;
  document.getElementById("actConfirmBtn")?.addEventListener("click", confirmCopilotAction);
  document.getElementById("actDiscardBtn")?.addEventListener("click", () => {
    clearActDraft();
    toast("Action draft discarded");
  });
}

async function requestCopilotActionDraft(instruction) {
  const data = await fetchJson(API_ENDPOINTS.copilotAct, {
    method: "POST",
    body: JSON.stringify({ instruction }),
  });
  return normalizeActResponse(data);
}

async function draftCopilotAction(event) {
  event.preventDefault();
  const input = document.getElementById("actInput");
  const button = document.getElementById("actDraftBtn");
  const container = document.getElementById("actDraft");
  const instruction = input?.value.trim() || "";
  if (!instruction) {
    input?.focus();
    return;
  }
  clearActDraft();
  if (button) {
    button.disabled = true;
    button.textContent = "Drafting…";
  }
  if (container) {
    container.hidden = false;
    container.innerHTML = '<div class="act-loading" role="status">Grounding a read-only action preview…</div>';
  }
  try {
    state.actDraft = await requestCopilotActionDraft(instruction);
    renderActDraft();
  } catch (error) {
    state.actDraft = null;
    if (container) {
      container.hidden = false;
      container.innerHTML = `<div class="auth-error" role="alert">${escapeHtml(error.message || "Could not draft that action.")}</div>`;
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Draft action";
    }
  }
}

async function confirmCopilotAction() {
  const preview = state.actDraft;
  const token = preview?.confirmationToken;
  const button = document.getElementById("actConfirmBtn");
  if (!token || preview?.confirmable === false || !button) return;
  button.disabled = true;
  button.textContent = "Confirming…";
  try {
    // Deliberately send only the opaque server token. The visible draft is
    // informational and is never trusted as write input.
    const result = await fetchJson(API_ENDPOINTS.copilotActConfirm, {
      method: "POST",
      body: JSON.stringify({ confirmationToken: token }),
    });
    state.actDraft = null;
    const container = document.getElementById("actDraft");
    if (container) {
      container.hidden = false;
      container.innerHTML = `
        <div class="act-success" role="status">
          <strong>Action confirmed</strong>
          <span>${escapeHtml(result.message || result.summary || "The confirmed marketplace action was completed.")}</span>
        </div>
      `;
    }
    const input = document.getElementById("actInput");
    if (input) input.value = "";
    toast(result.message || "Confirmed action completed");
    scheduleLiveRefresh(["resources", "bookings", "notifications", "dashboard", "analytics"]);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Confirm action";
    toast(error.message || "The action was not confirmed.");
  }
}

function webMcpResponse(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function webMcpArguments(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function webMcpResultLimit(value, fallback = 5) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(10, Math.floor(parsed))) : fallback;
}

function webMcpResourceView(resource) {
  const explanation = getResourceExplanation(resource);
  return {
    id: resource.id,
    name: resource.name,
    category: resource.category,
    cluster: resource.cluster,
    pricePerDay: Number(resource.pricePerDay) || 0,
    available: Boolean(resource.availability),
    verified: Boolean(resource.verified),
    rating: Number(resource.rating) || 0,
    capabilities: Array.isArray(resource.capabilities) ? resource.capabilities.slice(0, 12) : [],
    matchScore: explanation.score,
    why: explanation.why,
  };
}

function normalizedWebMcpResourceFilters(value) {
  const input = webMcpArguments(value);
  const maxPriceValue = Number(input.maxPricePerDay ?? input.maxPrice);
  return {
    query: String(input.query || "").trim().slice(0, 300),
    category: String(input.category || input.resourceType || "").trim().slice(0, 100),
    cluster: String(input.cluster || "").trim().slice(0, 100),
    maxPricePerDay: Number.isFinite(maxPriceValue) && maxPriceValue >= 0 ? maxPriceValue : null,
    verifiedOnly: input.verifiedOnly === true,
    availableOnly: input.availableOnly === true,
    sort: ["relevance", "price", "rating"].includes(input.sort) ? input.sort : "relevance",
    limit: webMcpResultLimit(input.limit),
  };
}

function filterWebMcpResources(value) {
  const filters = normalizedWebMcpResourceFilters(value);
  const queryTokens = normalizeString(filters.query).split(/\s+/).filter(Boolean);
  const category = normalizeString(filters.category);
  const cluster = normalizeString(filters.cluster);
  const budget = filters.maxPricePerDay ?? 999999999;
  const queryForScore = {
    resourceType: filters.category,
    cluster: filters.cluster,
    budget,
    deadline: "",
    search: filters.query,
  };
  const matches = state.resources
    .filter((resource) => {
      const haystack = normalizeString([
        resource.name,
        resource.category,
        resource.cluster,
        resource.description,
        ...(resource.tags || []),
        ...(resource.capabilities || []),
      ].join(" "));
      return (!queryTokens.length || queryTokens.every((token) => haystack.includes(token)))
        && (!category || normalizeString(`${resource.category} ${resource.name} ${(resource.capabilities || []).join(" ")}`).includes(category))
        && (!cluster || normalizeString(resource.cluster).includes(cluster))
        && (Number(resource.pricePerDay) || 0) <= budget
        && (!filters.verifiedOnly || resource.verified)
        && (!filters.availableOnly || resource.availability);
    })
    .map((resource) => ({ ...resource, match: resource.match || scoreMatch(resource, queryForScore) }));
  matches.sort((a, b) => {
    if (filters.sort === "price") return Number(a.pricePerDay) - Number(b.pricePerDay);
    if (filters.sort === "rating") return Number(b.rating) - Number(a.rating);
    return getResourceExplanation(b).score - getResourceExplanation(a).score;
  });
  return { filters, total: matches.length, matches: matches.slice(0, filters.limit) };
}

function webMcpCatalogueSummary() {
  if (!state.workspaceLoaded) {
    return webMcpResponse({ ok: false, code: "workspace_not_ready", message: "FREP is still loading or requires sign-in." });
  }
  const countBy = (field) => Object.entries(state.resources.reduce((counts, resource) => {
    const key = String(resource[field] || "Unspecified");
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {})).sort(([left], [right]) => left.localeCompare(right));
  return webMcpResponse({
    ok: true,
    mode: state.offlineReadOnly ? "offline_read_only" : "live_read_only",
    totalResources: state.resources.length,
    verifiedResources: state.resources.filter((resource) => resource.verified).length,
    availableResources: state.resources.filter((resource) => resource.availability).length,
    categories: countBy("category"),
    clusters: countBy("cluster"),
  });
}

function webMcpFilterResources(value) {
  if (!state.workspaceLoaded) {
    return webMcpResponse({ ok: false, code: "workspace_not_ready", message: "FREP is still loading or requires sign-in." });
  }
  const result = filterWebMcpResources(value);
  return webMcpResponse({
    ok: true,
    source: state.offlineReadOnly ? "cached_catalogue" : "loaded_catalogue",
    filters: result.filters,
    totalMatches: result.total,
    resources: result.matches.map(webMcpResourceView),
  });
}

async function webMcpSearchResources(value) {
  if (!state.workspaceLoaded) {
    return webMcpResponse({ ok: false, code: "workspace_not_ready", message: "FREP is still loading or requires sign-in." });
  }
  const local = filterWebMcpResources(value);
  let source = state.offlineReadOnly ? "cached_catalogue" : "local_fallback";
  let matches = local.matches;
  let total = local.total;
  if (!state.offlineReadOnly) {
    try {
      const data = await fetchJson("/api/match", {
        method: "POST",
        body: JSON.stringify({
          resourceType: local.filters.category,
          cluster: local.filters.cluster,
          budget: local.filters.maxPricePerDay ?? 999999999,
          search: local.filters.query,
          sort: local.filters.sort === "relevance" ? "match" : local.filters.sort,
          verifiedOnly: local.filters.verifiedOnly,
          availableOnly: local.filters.availableOnly,
        }),
      });
      matches = Array.isArray(data.results) ? data.results.slice(0, local.filters.limit) : [];
      total = Number.isFinite(Number(data.total)) ? Number(data.total) : matches.length;
      source = data.engine?.label || "FREP match engine";
    } catch {
      // A failed semantic request safely falls back to already-loaded public data.
    }
  }
  return webMcpResponse({
    ok: true,
    source,
    filters: local.filters,
    totalMatches: total,
    resources: matches.map(webMcpResourceView),
  });
}

function webMcpBookingDraftView(preview) {
  const action = webMcpArguments(preview.action);
  return {
    resourceIds: Array.isArray(action.resourceIds) ? action.resourceIds.slice(0, 10) : [],
    durationDays: Number(action.durationDays) || null,
    requestedResourceCount: Number(action.requestedResourceCount) || null,
    estimatedDailyTotal: Number(action.estimatedDailyTotal) || 0,
    estimatedTotal: Number(action.estimatedTotal) || 0,
  };
}

async function webMcpReviewBookingDraft(value) {
  const input = webMcpArguments(value);
  const instruction = String(input.instruction || "").trim().slice(0, 500);
  if (!state.authenticated || state.offlineReadOnly) {
    return webMcpResponse({ ok: false, code: "authentication_required", message: "Sign in online before preparing a booking draft." });
  }
  if (state.currentRole !== "buyer") {
    return webMcpResponse({ ok: false, code: "buyer_role_required", message: "Booking drafts are available only in the Buyer workspace." });
  }
  if (!instruction) {
    return webMcpResponse({ ok: false, code: "instruction_required", message: "Describe the resources and booking duration to review." });
  }
  const bookingInstruction = /\b(?:book|booking|reserve|reservation|hire)\b/i.test(instruction)
    ? instruction
    : `Book resources for this request: ${instruction}`;
  try {
    const preview = await requestCopilotActionDraft(bookingInstruction);
    state.actDraft = preview;
    const actInput = document.getElementById("actInput");
    if (actInput) actInput.value = instruction;
    setCopilotOpen(true);
    renderActDraft();
    const isBooking = preview.actionName === "createBooking";
    const confirmationAvailable = Boolean(isBooking && preview.confirmationToken && preview.confirmable);
    return webMcpResponse({
      ok: isBooking,
      status: confirmationAvailable ? "awaiting_user_confirmation" : "draft_needs_review",
      action: preview.actionName,
      summary: preview.summary,
      draft: isBooking ? webMcpBookingDraftView(preview) : null,
      matches: (Array.isArray(preview.matches) ? preview.matches : []).map(webMcpResourceView),
      warnings: Array.isArray(preview.warnings) ? preview.warnings : [],
      missingFields: Array.isArray(preview.missingFields) ? preview.missingFields : [],
      confirmationAvailable,
      wroteMarketplaceData: false,
      nextStep: confirmationAvailable
        ? "The user must review the visible Copilot Act panel and explicitly click Confirm action."
        : "Review the visible Copilot Act panel and revise the instruction if needed.",
    });
  } catch (error) {
    return webMcpResponse({ ok: false, code: "draft_failed", message: error.message || "FREP could not prepare that booking draft." });
  }
}

let webMcpInitializationPromise = null;
let webMcpRegistrationController = null;

function initializeWebMcpTools() {
  if (webMcpInitializationPromise) return webMcpInitializationPromise;
  webMcpInitializationPromise = (async () => {
    let modelContext = null;
    try {
      // document.modelContext is the current WebMCP origin-trial API. The
      // navigator surface is retained only for older experimental Chrome builds.
      modelContext = document.modelContext || navigator.modelContext || null;
    } catch {
      return false;
    }
    if (!modelContext || typeof modelContext.registerTool !== "function") return false;

    webMcpRegistrationController = typeof AbortController === "function" ? new AbortController() : null;
    const registrationOptions = webMcpRegistrationController ? { signal: webMcpRegistrationController.signal } : undefined;
    const readOnlyAnnotations = { readOnlyHint: true, untrustedContentHint: true };
    const tools = [
      {
        name: "frep_catalogue_summary",
        title: "Summarize FREP catalogue",
        description: "Read aggregate counts for the currently loaded FREP resource catalogue. This never changes marketplace data.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: readOnlyAnnotations,
        execute: () => webMcpCatalogueSummary(),
      },
      {
        name: "frep_filter_resources",
        title: "Filter FREP resources",
        description: "Filter the already-loaded catalogue by literal attributes without changing the page or marketplace data.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", maxLength: 300, description: "Literal words expected in a resource name, description, tag, or capability." },
            category: { type: "string", maxLength: 100 },
            cluster: { type: "string", maxLength: 100 },
            maxPricePerDay: { type: "number", minimum: 0 },
            verifiedOnly: { type: "boolean" },
            availableOnly: { type: "boolean" },
            sort: { type: "string", enum: ["relevance", "price", "rating"] },
            limit: { type: "integer", minimum: 1, maximum: 10 },
          },
          additionalProperties: false,
        },
        annotations: readOnlyAnnotations,
        execute: (input) => webMcpFilterResources(input),
      },
      {
        name: "frep_search_resources",
        title: "Search FREP resources",
        description: "Run FREP's grounded match search and return a bounded, read-only resource result set. This never books or edits anything.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", maxLength: 300, description: "Natural-language capability or resource requirement." },
            category: { type: "string", maxLength: 100 },
            cluster: { type: "string", maxLength: 100 },
            maxPricePerDay: { type: "number", minimum: 0 },
            verifiedOnly: { type: "boolean" },
            availableOnly: { type: "boolean" },
            sort: { type: "string", enum: ["relevance", "price", "rating"] },
            limit: { type: "integer", minimum: 1, maximum: 10 },
          },
          additionalProperties: false,
        },
        annotations: readOnlyAnnotations,
        execute: (input) => webMcpSearchResources(input),
      },
      {
        name: "frep_review_booking_draft",
        title: "Review a FREP booking draft",
        description: "Prepare and display a signed Copilot Act booking draft for human review. It cannot confirm, book, or write marketplace data; the user must click Confirm action in FREP.",
        inputSchema: {
          type: "object",
          properties: {
            instruction: { type: "string", minLength: 1, maxLength: 500, description: "Resources, location, budget, and duration to include in the draft." },
          },
          required: ["instruction"],
          additionalProperties: false,
        },
        // The call changes transient review UI, so it is not annotated read-only
        // even though it deliberately performs no marketplace write.
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: (input) => webMcpReviewBookingDraft(input),
      },
    ];

    let registered = 0;
    for (const tool of tools) {
      try {
        await Promise.resolve(modelContext.registerTool(tool, registrationOptions));
        registered += 1;
      } catch (error) {
        // WebMCP remains experimental (permissions policy and origin-trial
        // variants differ). A failed registration must never affect normal UI.
        console.debug?.(`Optional WebMCP tool ${tool.name} was not registered.`, error);
      }
    }
    return registered > 0;
  })();
  return webMcpInitializationPromise;
}

const voiceControllers = new Map();
let activeVoiceController = null;

function detectTranscriptLanguage(text) {
  if (/[ऀ-ॿ]/u.test(text)) return "Hindi";
  if (/[஀-௿]/u.test(text)) return "Tamil";
  if (/[ఀ-౿]/u.test(text)) return "Telugu";
  if (/[a-z]/iu.test(text)) return "English";
  return "Unknown";
}

class VoiceInputController {
  constructor(root) {
    this.root = root;
    this.input = document.getElementById(root.querySelector("[data-voice-start]")?.dataset.voiceTarget || "");
    this.startButton = root.querySelector("[data-voice-start]");
    this.stopButton = root.querySelector("[data-voice-stop]");
    this.language = root.querySelector("[data-voice-language]");
    this.status = root.querySelector("[data-voice-status]");
    this.Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = null;
    this.active = false;
    this.baseText = "";
    this.finalText = "";
    const savedLanguage = localStorage.getItem("frep-voice-language") || "auto";
    if (this.language && [...this.language.options].some((option) => option.value === savedLanguage)) this.language.value = savedLanguage;
    this.startButton?.addEventListener("click", () => this.start());
    this.stopButton?.addEventListener("click", () => this.stop());
    this.language?.addEventListener("change", () => localStorage.setItem("frep-voice-language", this.language.value));
    if (!this.Recognition || !this.input) this.markUnsupported();
  }

  markUnsupported() {
    if (this.startButton) this.startButton.disabled = true;
    if (this.stopButton) this.stopButton.disabled = true;
    this.root.classList.add("unsupported");
    if (this.status) this.status.textContent = "Voice is unavailable in this browser; type instead.";
  }

  setUi(listening, message) {
    this.root.classList.toggle("listening", listening);
    if (this.startButton) {
      this.startButton.disabled = listening;
      this.startButton.setAttribute("aria-pressed", String(listening));
    }
    if (this.stopButton) this.stopButton.disabled = !listening;
    if (this.status) this.status.textContent = message;
  }

  start() {
    if (!this.Recognition || !this.input || this.active) return;
    if (activeVoiceController && activeVoiceController !== this) activeVoiceController.stop();
    this.recognition = new this.Recognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    const selectedLanguage = this.language?.value || "auto";
    // Web Speech must choose a recognition locale before listening. "Auto"
    // uses the browser locale, then reports lightweight script detection from
    // the resulting transcript; it does not claim acoustic auto-detection.
    this.recognition.lang = selectedLanguage === "auto" ? (navigator.language || "en-IN") : selectedLanguage;
    this.baseText = this.input.value.trim();
    this.finalText = "";
    this.active = true;
    activeVoiceController = this;
    this.recognition.onresult = (event) => this.onResult(event);
    this.recognition.onerror = (event) => this.onError(event);
    this.recognition.onend = () => this.onEnd();
    try {
      this.recognition.start();
      this.setUi(true, `Listening in ${this.language?.selectedOptions?.[0]?.textContent || "auto language"}…`);
    } catch {
      this.active = false;
      activeVoiceController = null;
      this.setUi(false, "Voice could not start. Check microphone permission.");
    }
  }

  onResult(event) {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript?.trim() || "";
      if (event.results[index].isFinal) this.finalText = `${this.finalText} ${transcript}`.trim();
      else interim = `${interim} ${transcript}`.trim();
    }
    const nextValue = [this.baseText, this.finalText, interim].filter(Boolean).join(" ");
    this.input.value = nextValue;
    this.input.dispatchEvent(new Event("input", { bubbles: true }));
    const spokenText = [this.finalText, interim].filter(Boolean).join(" ");
    const detected = this.language?.value === "auto" ? ` · detected script: ${detectTranscriptLanguage(spokenText)}` : "";
    if (this.status) this.status.textContent = interim ? `Hearing: ${interim}${detected}` : `Listening${detected}…`;
  }

  onError(event) {
    const messages = {
      "not-allowed": "Microphone permission was denied.",
      "service-not-allowed": "Speech recognition is blocked by the browser.",
      "no-speech": "No speech was detected. You can try again.",
      "audio-capture": "No microphone was found.",
      network: "Speech recognition lost its network connection.",
    };
    this.active = false;
    if (activeVoiceController === this) activeVoiceController = null;
    this.setUi(false, messages[event.error] || "Voice input stopped unexpectedly.");
  }

  onEnd() {
    if (!this.active) return;
    this.active = false;
    if (activeVoiceController === this) activeVoiceController = null;
    this.setUi(false, "Voice stopped. Transcript is ready to edit.");
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    if (activeVoiceController === this) activeVoiceController = null;
    try {
      this.recognition?.stop();
    } catch {
      /* Recognition may already have stopped. */
    }
    this.setUi(false, "Voice stopped. Transcript is ready to edit.");
  }
}

function initializeVoiceInput() {
  document.querySelectorAll("[data-voice-controls]").forEach((root) => {
    const key = root.dataset.voiceControls;
    if (!voiceControllers.has(key)) voiceControllers.set(key, new VoiceInputController(root));
  });
}

function stopAllVoiceInput() {
  voiceControllers.forEach((controller) => controller.stop());
}

let liveEventSource = null;
let liveEventGeneration = 0;
let liveLastEventId = "";
let liveReconnectTimer = null;
let liveReconnectAttempt = 0;
let liveRefreshTimer = null;
const pendingLiveScopes = new Set();

function setLiveEventStatus(status, label) {
  const element = document.getElementById("liveEventStatus");
  if (!element) return;
  element.dataset.state = status;
  element.title = label;
  const visibleLabel = element.querySelector("[data-live-status-label]");
  if (visibleLabel) visibleLabel.textContent = label;
}

function closeLiveEvents(updateStatus = true, resetCursor = true) {
  liveEventGeneration += 1;
  liveEventSource?.close();
  liveEventSource = null;
  if (liveReconnectTimer) window.clearTimeout(liveReconnectTimer);
  liveReconnectTimer = null;
  if (liveRefreshTimer) window.clearTimeout(liveRefreshTimer);
  liveRefreshTimer = null;
  pendingLiveScopes.clear();
  if (resetCursor) liveLastEventId = "";
  if (updateStatus) setLiveEventStatus("offline", "Live updates off");
}

function connectLiveEvents() {
  closeLiveEvents(false, false);
  if (!state.authenticated) return;
  if (!("EventSource" in window)) {
    setLiveEventStatus("unsupported", "Live updates unavailable");
    return;
  }
  const generation = liveEventGeneration;
  setLiveEventStatus("connecting", "Connecting live updates…");
  const cursor = /^\d+$/.test(liveLastEventId) ? `?after=${encodeURIComponent(liveLastEventId)}` : "";
  const source = new EventSource(`${BASE_URL}${API_ENDPOINTS.events}${cursor}`, { withCredentials: true });
  liveEventSource = source;
  source.onopen = () => {
    if (generation !== liveEventGeneration) return;
    liveReconnectAttempt = 0;
    setLiveEventStatus("connected", "Live updates on");
  };
  const receive = (event) => {
    if (generation !== liveEventGeneration || !state.authenticated) return;
    if (/^\d+$/.test(event.lastEventId || "")) liveLastEventId = event.lastEventId;
    let payload = {};
    try {
      payload = event.data ? JSON.parse(event.data) : {};
    } catch {
      return;
    }
    if (/^\d+$/.test(String(payload.cursor ?? ""))) liveLastEventId = String(payload.cursor);
    handleLiveEvent(event.type, payload);
  };
  source.onmessage = receive;
  ["ready", "reconnect", "notification", "resource", "resource_updated", "booking", "dashboard", "analytics", "refresh", "ping", "heartbeat"]
    .forEach((eventName) => source.addEventListener(eventName, receive));
  source.onerror = () => {
    if (generation !== liveEventGeneration || !state.authenticated) return;
    source.close();
    if (liveEventSource === source) liveEventSource = null;
    liveReconnectAttempt += 1;
    const delay = Math.min(30000, 1000 * (2 ** Math.min(liveReconnectAttempt - 1, 5)));
    setLiveEventStatus("reconnecting", "Reconnecting live updates…");
    liveReconnectTimer = window.setTimeout(() => {
      if (generation === liveEventGeneration && state.authenticated) verifySessionBeforeLiveReconnect(generation);
    }, delay);
  };
}

async function verifySessionBeforeLiveReconnect(generation) {
  if (generation !== liveEventGeneration || !state.authenticated) return;
  try {
    const session = await fetchJson("/api/auth/session", { suppressAuth: true, cache: "no-store" });
    if (!session.authenticated || !session.user) {
      requireAuthentication("Your session expired. Sign in again to restore live updates.");
      return;
    }
    state.user = { ...session.user, role: String(session.user.role || "").toLowerCase() };
    state.currentRole = state.user.role;
    connectLiveEvents();
  } catch (error) {
    if (generation !== liveEventGeneration || !state.authenticated) return;
    if (!navigator.onLine && enterOfflineReadOnly("Connection lost. Showing the cached public catalogue.")) return;
    const delay = Math.min(30000, 1000 * (2 ** Math.min(liveReconnectAttempt, 5)));
    liveReconnectTimer = window.setTimeout(() => verifySessionBeforeLiveReconnect(generation), delay);
  }
}

function handleLiveEvent(eventType, payload) {
  const type = eventType === "message" ? String(payload.type || "refresh") : eventType;
  if (["ready", "reconnect", "ping", "heartbeat", "connected"].includes(type)) return;
  const note = payload.notification || (type === "notification" ? payload.data || payload : null);
  if (note?.title) toast(note.title);
  const scopes = [];
  const relatedType = String(note?.relatedEntityType || note?.related_entity_type || "");
  const eventHint = `${type} ${note?.kind || ""} ${note?.type || ""} ${note?.title || ""}`;
  if (/resource|listing|verification|approval/i.test(eventHint) || /resource|listing/i.test(relatedType) || payload.resource || payload.resourcesChanged) scopes.push("resources", "analytics", "dashboard");
  if (/booking/i.test(eventHint) || /booking/i.test(relatedType) || payload.booking || payload.bookingsChanged) scopes.push("bookings", "notifications", "analytics", "dashboard");
  if (/notification/i.test(type) || note || payload.notificationsChanged) scopes.push("notifications", "dashboard");
  if (/analytics/i.test(type)) scopes.push("analytics");
  if (/dashboard/i.test(type)) scopes.push("dashboard");
  if (type === "refresh" || payload.refresh === true) scopes.push("resources", "notifications", "dashboard", "analytics", "bookings");
  scheduleLiveRefresh(scopes.length ? scopes : ["notifications", "resources"]);
}

function scheduleLiveRefresh(scopes = []) {
  scopes.forEach((scope) => pendingLiveScopes.add(scope));
  if (liveRefreshTimer) return;
  liveRefreshTimer = window.setTimeout(async () => {
    liveRefreshTimer = null;
    if (!state.authenticated) return;
    const requested = new Set(pendingLiveScopes);
    pendingLiveScopes.clear();
    const loaders = [];
    if (requested.has("resources")) loaders.push(loadResources());
    if (requested.has("notifications")) loaders.push(loadNotifications());
    if (requested.has("dashboard")) loaders.push(loadDashboard());
    if (requested.has("analytics")) loaders.push(loadAnalytics());
    if (requested.has("bookings") && state.currentRole === "buyer") loaders.push(loadBookings());
    await Promise.allSettled(loaders);
    if (state.authenticated) render();
  }, 220);
}

function bindEvents() {
  document.getElementById("loginForm")?.addEventListener("submit", signIn);
  document.querySelectorAll("[data-demo-username]").forEach((button) => {
    button.addEventListener("click", () => {
      const username = document.getElementById("loginUsername");
      const password = document.getElementById("loginPassword");
      if (username) username.value = button.dataset.demoUsername || "";
      if (password) password.value = button.dataset.demoPassword || "";
      document.getElementById("loginError")?.setAttribute("hidden", "");
      document.getElementById("loginSubmit")?.focus();
    });
  });
  document.getElementById("logoutBtn")?.addEventListener("click", signOut);
  document.getElementById("offlineRetryBtn")?.addEventListener("click", () => recoverOnlineSession());
  document.getElementById("actForm")?.addEventListener("submit", draftCopilotAction);
  initializeVoiceInput();

  document.querySelector(".side-nav")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) setView(button.dataset.view);
  });

  document.getElementById("matchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.offlineReadOnly) {
      renderMatchResults();
      toast("Showing matches from the cached catalogue");
      return;
    }
    await runServerMatch();
  });
  document.getElementById("matchForm").addEventListener("input", () => renderMatchResults());

  document.getElementById("listForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitResource();
    event.target.reset();
    resetCompose("listing");
  });

  document.getElementById("quickBookBtn").addEventListener("click", async () => {
    const resourceId = document.getElementById("quickBookingSelect").value;
    if (resourceId) {
      await submitBooking([resourceId], "Demo Buyer");
      document.getElementById("quickBookingSelect").value = "";
      renderBookingOptions();
    }
  });

  document.getElementById("clusterInput").addEventListener("input", () => {
    state.clusterFilter = document.getElementById("clusterInput").value.trim();
    renderMatchResults();
    renderMap();
  });
  document.getElementById("verifiedOnly").addEventListener("change", (event) => {
    state.verifiedOnly = event.target.checked;
    renderMatchResults();
  });
  document.getElementById("availableOnly").addEventListener("change", (event) => {
    state.availableOnly = event.target.checked;
    renderMatchResults();
  });
  document.getElementById("resetFiltersBtn").addEventListener("click", () => {
    document.getElementById("resourceType").value = "";
    document.getElementById("clusterInput").value = "";
    document.getElementById("budgetInput").value = 9000;
    document.getElementById("deadlineInput").value = "";
    document.getElementById("searchInput").value = "";
    document.getElementById("sortInput").value = "score";
    document.getElementById("verifiedOnly").checked = false;
    document.getElementById("availableOnly").checked = false;
    document.getElementById("nlMatchInput").value = "";
    resetCompose("search");
    state.clusterFilter = "";
    state.verifiedOnly = false;
    state.availableOnly = false;
    renderMatchResults();
    renderMap();
  });
  document.getElementById("parseNlBtn")?.addEventListener("click", () => parseNaturalLanguageIntoMatch().catch((error) => toast(error.message)));
  document.getElementById("addToCartBtn").addEventListener("click", () => {
    const btn = document.querySelector("#matchResults [data-add-cart]");
    if (btn) {
      addBookingToCart(btn.dataset.addCart);
      renderBookingOptions();
    }
  });
  document.getElementById("submitBundleBtn").addEventListener("click", async () => {
    if (state.cart.length) await submitBooking([...state.cart], "Bundle Buyer");
  });

  document.addEventListener("click", async (event) => {
    const approveButton = event.target.closest("[data-approve]");
    if (approveButton) return patchResource(approveButton.dataset.approve, { verified: true });
    const rejectButton = event.target.closest("[data-reject]");
    if (rejectButton) return patchResource(rejectButton.dataset.reject, { verified: false });
    const removeButton = event.target.closest("[data-remove-resource]");
    if (removeButton) return removeResource(removeButton.dataset.removeResource);
    const quickBook = event.target.closest("[data-quick-book]");
    if (quickBook) return submitBooking([quickBook.dataset.quickBook], "Demo Buyer");
    const addCart = event.target.closest("[data-add-cart]");
    if (addCart) {
      addBookingToCart(addCart.dataset.addCart);
      renderBookingOptions();
    }
    const completeBooking = event.target.closest("[data-complete-booking]");
    if (completeBooking) return updateBookingStatus(completeBooking.dataset.completeBooking, "complete");
  });

  document.addEventListener("change", async (event) => {
    const rateInput = event.target.closest("[data-rate-booking]");
    if (rateInput) return updateBookingStatus(rateInput.dataset.rateBooking, "rate", Number(rateInput.value));
    const priceInput = event.target.closest("[data-edit-price]");
    if (priceInput) return patchResource(priceInput.dataset.editPrice, { pricePerDay: Number(priceInput.value) });
    const toggle = event.target.closest("[data-toggle-avail]");
    if (toggle) return patchResource(toggle.dataset.toggleAvail, { availability: toggle.checked });
  });

  document.getElementById("mapVisual").addEventListener("click", (event) => {
    const node = event.target.closest("[data-cluster]");
    if (!node) return;
    state.clusterFilter = node.dataset.cluster;
    document.getElementById("clusterInput").value = node.dataset.cluster;
    setView("match");
    renderMatchResults();
    renderMap();
  });
  document.getElementById("quickBookingSelect").addEventListener("change", (event) => {
    document.getElementById("quickBookBtn").disabled = !event.target.value;
  });
  document.getElementById("productionPlannerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitProductionPlan();
  });
  document.getElementById("productProcesses")?.addEventListener("input", () => renderProcessSuggestions());
  renderProcessSuggestions();
  document.getElementById("fillFromNlBtn")?.addEventListener("click", () => fillPlannerFromNl().catch((error) => toast(error.message)));
  document.getElementById("demoModeBtn").addEventListener("click", () => runDemoScenario());
  document.getElementById("copilotToggle")?.addEventListener("click", () => setCopilotOpen(!state.copilotOpen));
  document.getElementById("copilotClose")?.addEventListener("click", () => setCopilotOpen(false));
  document.getElementById("copilotForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("copilotInput");
    const message = input.value;
    input.value = "";
    setCopilotOpen(true);
    await sendCopilot(message);
  });
  document.getElementById("themeToggle")?.addEventListener("click", () => {
    applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
  });
  document.getElementById("commandOpenBtn")?.addEventListener("click", () => {
    document.getElementById("commandDialog").showModal();
    document.getElementById("commandInput").focus();
  });
  document.getElementById("commandForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = document.getElementById("commandInput").value;
    document.getElementById("commandDialog").close();
    setCopilotOpen(true);
    await sendCopilot(value);
    document.getElementById("commandInput").value = "";
  });
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      document.getElementById("commandDialog").showModal();
      document.getElementById("commandInput").focus();
    }
  });
  window.addEventListener("online", () => recoverOnlineSession());
  window.addEventListener("offline", () => {
    if (!(state.authenticated || state.offlineReadOnly)) return;
    if (!enterOfflineReadOnly("Connection lost. Showing the cached public catalogue.")) {
      requireAuthentication("You are offline and no cached catalogue is available yet.");
    }
  });
}

async function submitProductionPlan() {
  const payload = {
    productName: document.getElementById("productName").value,
    quantity: Number(document.getElementById("productQuantity").value),
    material: document.getElementById("productMaterial").value,
    processes: document.getElementById("productProcesses").value,
    deadline: Number(document.getElementById("productDeadline").value),
    budget: Number(document.getElementById("productBudget").value),
    cluster: document.getElementById("productCluster").value,
    quality: document.getElementById("productQuality").value,
    transport: "Standard",
    naturalLanguage: document.getElementById("plannerNl")?.value || "",
  };
  state.productionPlan = await fetchJson("/api/production/plan", { method: "POST", body: JSON.stringify(payload) });
  renderProductionPlan();
}

async function runDemoScenario() {
  setView("planner");
  document.getElementById("productName").value = "Aluminium Bracket";
  document.getElementById("productQuantity").value = 2000;
  document.getElementById("productMaterial").value = "Aluminium";
  document.getElementById("productProcesses").value = "CNC machining, Surface finishing, Quality inspection, Logistics";
  document.getElementById("productDeadline").value = 5;
  document.getElementById("productBudget").value = 100000;
  document.getElementById("productCluster").value = "Coimbatore";
  document.getElementById("productQuality").value = "High";
  document.getElementById("plannerNl").value = "Produce 2000 aluminium brackets in Coimbatore in 5 days with CNC, finishing, inspection and logistics, budget 100000";
  await submitProductionPlan();
  toast("Demo production chain generated");
}

function renderProductionPlan() {
  const result = document.getElementById("productionPlanResult");
  if (!result) return;
  if (!state.productionPlan) {
    result.innerHTML = '<div class="result-card">Use the production planner to build an intelligent resource chain.</div>';
    return;
  }
  const plan = state.productionPlan.bundle;
  const capabilities = (plan.capabilities || []).map((cap) => `<span class="badge verified">${escapeHtml(cap)}</span>`).join(" ");
  const chainHtml = plan.chain.length
    ? plan.chain.map((item) => {
      const explainedResource = { ...item.resource, why: item.why || item.explanation?.why || item.scoreBreakdown?.why, explanation: item.explanation };
      const matchInfo = getResourceExplanation(explainedResource, item.match || item.scoreBreakdown);
      return `
      <div class="result-card">
        <div class="result-head">
          <div>
            <strong>${escapeHtml(item.capability)}</strong>
            <div class="muted">${escapeHtml(item.resource.name)} · ${escapeHtml(item.resource.cluster)} · ${escapeHtml(item.resource.ownerName)}</div>
          </div>
          <span class="badge verified">${escapeHtml(matchInfo.score)}%</span>
        </div>
        <div class="muted">₹${escapeHtml(item.resource.pricePerDay)}/day · Rating ${escapeHtml(item.resource.rating)} · ${item.resource.verified ? "Verified" : "Unverified"}</div>
        ${explanationHtml(explainedResource, item.match || item.scoreBreakdown)}
      </div>
    `;
    }).join("")
    : '<div class="result-card">No matching resource chain was found for the requirement.</div>';
  const optionsHtml = (plan.options || []).map((option) => `
    <div class="result-card">
      <div class="result-head">
        <div><strong>${escapeHtml(option.label)}</strong></div>
        <span class="badge ${option.risk === "LOW" ? "verified" : option.risk === "MEDIUM" ? "pending" : "unverified"}">${escapeHtml(option.risk)}</span>
      </div>
      <div class="muted">Total: ₹${escapeHtml(option.estimatedTotal)}, Duration: ${escapeHtml(option.estimatedDuration)} days, Transport: ₹${escapeHtml(option.estimatedTransport)}</div>
    </div>
  `).join("");
  const decisionsHtml = (plan.decisionAnalysis || []).map((decision) => `
    <div class="result-card">
      <strong>${escapeHtml(decision.option)}</strong>
      <div class="muted">Estimated cost: ₹${escapeHtml(decision.estimatedCost)} · Estimated time: ${escapeHtml(decision.estimatedDays)} days</div>
      <div class="muted">${escapeHtml(decision.assumption)}</div>
    </div>
  `).join("");
  const req = state.productionPlan.requirements || {};
  result.innerHTML = `
    <div class="result-card">
      <div class="result-head">
        <div>
          <strong>Production requirement analyzed</strong>
          <div class="muted">${escapeHtml(req.product_name || req.productName)} · ${escapeHtml(req.quantity)} units · ${escapeHtml(req.material)}</div>
        </div>
        <span class="badge ${plan.feasible ? "verified" : "unverified"}">${plan.feasible ? "Feasible" : "Review"}</span>
      </div>
      <div class="muted">Required capabilities:</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">${capabilities}</div>
      <div style="margin-top:12px;"><strong>Recommended chain</strong></div>
      ${chainHtml}
      <div style="margin-top:12px;"><strong>Bundle alternatives</strong></div>
      ${optionsHtml}
      <div style="margin-top:12px;"><strong>Estimated decision analysis</strong></div>
      ${decisionsHtml}
      ${plan.feasible ? '<button class="primary" id="bookPlanBundleBtn" type="button">Book recommended bundle</button>' : ""}
    </div>
  `;
  document.getElementById("bookPlanBundleBtn")?.addEventListener("click", async () => {
    const ids = plan.chain.map((item) => item.resource.id);
    if (ids.length) await submitBooking(ids, "Planner Buyer");
  });
}

function inferCapabilitiesFromProcesses(text) {
  const lowers = (text || "").toLowerCase();
  const caps = new Set();
  if (!lowers) return [];
  if (/cnc|lathe|mill|machin/.test(lowers)) caps.add("CNC Machining");
  if (/finish|coating|paint|surface/.test(lowers)) caps.add("Surface Finishing");
  if (/inspect|quality|cmm|testing|lab/.test(lowers)) caps.add("Quality Inspection");
  if (/operator|skilled|manpower/.test(lowers)) caps.add("Skilled Operator");
  if (/truck|logist|transport|forklift/.test(lowers)) caps.add("Logistics");
  if (/warehouse|storage/.test(lowers)) caps.add("Storage");
  if (!caps.size) caps.add("CNC Machining");
  return Array.from(caps);
}

function countResourcesForCapability(capability) {
  const key = capability.toLowerCase();
  return state.resources.reduce((acc, r) => {
    const hay = `${r.name} ${r.description} ${(r.tags || []).join(" ")}`.toLowerCase();
    return acc + (hay.includes(key) || (r.category || "").toLowerCase().includes(key) ? 1 : 0);
  }, 0);
}

function renderProcessSuggestions() {
  const input = document.getElementById("productProcesses");
  const suggest = document.getElementById("productProcessesSuggestions");
  if (!input || !suggest) return;
  const caps = inferCapabilitiesFromProcesses(input.value);
  if (!caps.length) {
    suggest.innerHTML = "";
    return;
  }
  suggest.innerHTML = caps.map((cap) => {
    const count = countResourcesForCapability(cap);
    const top = getTopResourcesForCapability(cap, 3);
    const thumbs = top.map((r) => `
      <div style="display:flex;gap:8px;align-items:center;">
        <div class="suggestion-thumb">${escapeHtml((r.name || "").split(" ").slice(0, 2).map((s) => s[0]).join("").toUpperCase())}</div>
        <div class="suggestion-info"><div class="suggestion-name">${escapeHtml(r.name)}</div><div class="suggestion-sub">${escapeHtml(r.cluster)} · ₹${escapeHtml(r.pricePerDay)}</div></div>
      </div>
    `).join("");
    return `<div class="suggestion-item" data-cap="${escapeHtml(cap)}"><div><div style="font-weight:700">${escapeHtml(cap)}</div><div class="suggestion-sub">${count} matches</div></div><div style="display:flex; gap:8px;">${thumbs}</div></div>`;
  }).join("");
  suggest.querySelectorAll(".suggestion-item").forEach((el) => {
    el.addEventListener("click", (ev) => {
      const cap = el.dataset.cap;
      const cur = input.value.split(",").map((s) => s.trim()).filter(Boolean);
      if (!cur.includes(cap)) cur.push(cap);
      input.value = cur.join(", ");
      renderProcessSuggestions();
      ev.stopPropagation();
    });
  });
}

function getTopResourcesForCapability(capability, limit = 3) {
  const key = capability.toLowerCase();
  return state.resources.map((r) => ({ ...r, scoreRank: ((r.verified ? 1 : 0) * 100) + (r.rating || 0) }))
    .filter((r) => (r.capabilities || []).map((c) => c.toLowerCase()).includes(key) || `${r.name} ${r.description} ${(r.tags || []).join(" ")}`.toLowerCase().includes(key))
    .sort((a, b) => b.scoreRank - a.scoreRank)
    .slice(0, limit);
}

bindEvents();
init().catch((error) => toast(error.message || "Failed to start FREP"));
