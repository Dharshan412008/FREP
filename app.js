const BASE_URL = '';
const CURRENT_OWNER_ID = 'O-100';

const state = {
  currentRole: 'buyer',
  resources: [],
  clusters: [],
  bookings: [],
  notifications: [],
  dashboard: {},
  analytics: { categories: [], listed: [], demand: [], trendLabels: [], trend: [], carbonSavings: 0 },
  productionPlan: null,
  clusterFilter: '',
  verifiedOnly: false,
  availableOnly: false,
  cart: [],
};

const summaryLabels = {
  resources_listed: 'Resources listed',
  available_resources: 'Available resources',
  pending_verifications: 'Pending verification',
  verified_msmes: 'Verified MSMEs',
  average_cost_per_day: 'Average cost/day',
  active_bookings: 'Active bookings',
  capex_avoided: 'Estimated capex avoided',
  carbonSavings: 'CO2 saved (kg)',
};

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return res.json();
}

async function init() {
  await Promise.all([loadDashboard(), loadResources(), loadClusters(), loadBookings(), loadAnalytics(), loadNotifications()]);
  render();
}

async function loadDashboard() {
  state.dashboard = await fetchJson('/api/dashboard');
}

async function loadResources() {
  state.resources = await fetchJson('/api/resources');
}

async function loadClusters() {
  state.clusters = await fetchJson('/api/clusters');
}

async function loadBookings() {
  state.bookings = await fetchJson('/api/bookings');
}

async function loadAnalytics() {
  state.analytics = await fetchJson('/api/analytics');
}

async function loadNotifications() {
  state.notifications = await fetchJson('/api/notifications');
}

function getCurrentOwnerId() {
  return CURRENT_OWNER_ID;
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

  setDatalistOptions('clusterSuggestions', clusters, (value) => {
    const cluster = state.clusters.find((item) => item.name === value);
    return cluster ? `${cluster.city}, ${cluster.state}` : '';
  });
  setDatalistOptions('resourceNameSuggestions', resourceNames);
  setDatalistOptions('resourceSearchSuggestions', searchTerms);
}

function setDatalistOptions(id, values, getLabel = () => '') {
  const list = document.getElementById(id);
  if (!list) return;
  const uniqueValues = [...new Set(values.filter(Boolean).map((value) => String(value).trim()))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  list.replaceChildren(...uniqueValues.map((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.label = getLabel(value);
    return option;
  }));
}

function updateRoleBadge() {
  const badge = document.getElementById('roleBadge');
  const label = state.currentRole === 'owner' ? 'Resource Owner' : state.currentRole === 'admin' ? 'Network Admin' : 'Buyer';
  badge.textContent = `Active role: ${label}`;
}

function updateSectionVisibility() {
  document.querySelector('.panel.listing').style.display = state.currentRole === 'owner' ? 'block' : 'none';
  document.querySelector('.panel.owner').style.display = state.currentRole === 'owner' ? 'block' : 'none';
  document.querySelector('.panel.admin').style.display = state.currentRole === 'admin' ? 'block' : 'none';
  document.querySelector('.panel.booking').style.display = state.currentRole !== 'admin' ? 'block' : 'none';
  document.querySelector('.panel.planner').style.display = state.currentRole === 'buyer' ? 'block' : 'none';
}

function normalizeString(value) {
  return String(value || '').trim().toLowerCase();
}

function scoreMatch(resource, query) {
  const categoryFit = !query.resourceType || resource.category === query.resourceType ? 1 : 0.7;
  const locationFit = !query.cluster || normalizeString(resource.cluster).includes(normalizeString(query.cluster)) ? 1 : 0.7;
  const costFit = resource.pricePerDay <= query.budget ? 1 : Math.max(0.45, 1 - (resource.pricePerDay - query.budget) / (query.budget || 10000));
  const availabilityFit = resource.availability ? 1 : 0.2;
  const verificationBonus = resource.verified ? 1 : 0.6;
  const daysToDeadline = query.deadline ? Math.max(1, Math.ceil((new Date(query.deadline) - new Date()) / (1000 * 60 * 60 * 24))) : 7;
  const deadlineFit = daysToDeadline <= 3 ? (resource.availability ? 1 : 0.3) : 0.8;
  const compatibilityFit = query.search ? (resource.tags.some((tag) => query.search.toLowerCase().includes(tag.toLowerCase())) ? 1 : 0.75) : 0.9;
  const score = Math.round((categoryFit * 0.22 + locationFit * 0.18 + costFit * 0.18 + availabilityFit * 0.18 + verificationBonus * 0.12 + deadlineFit * 0.08 + compatibilityFit * 0.04) * 100);
  return { score, breakdown: { categoryFit, locationFit, costFit, availabilityFit, verificationBonus, deadlineFit, compatibilityFit } };
}

function getFilteredResources() {
  const resourceType = document.getElementById('resourceType').value;
  const cluster = state.clusterFilter || document.getElementById('clusterInput').value;
  const budget = Number(document.getElementById('budgetInput').value) || 999999;
  const search = document.getElementById('searchInput').value;
  return state.resources.filter((resource) => {
    const matchesType = !resourceType || resource.category === resourceType || normalizeString(resource.name).includes(normalizeString(resourceType));
    const matchesCluster = !cluster || normalizeString(resource.cluster).includes(normalizeString(cluster));
    const matchesSearch = !search || normalizeString(`${resource.name} ${resource.category} ${resource.cluster} ${resource.tags.join(' ')}`).includes(normalizeString(search));
    const matchesBudget = resource.pricePerDay <= budget;
    const matchesVerified = !state.verifiedOnly || resource.verified;
    const matchesAvailable = !state.availableOnly || resource.availability;
    return matchesType && matchesCluster && matchesSearch && matchesBudget && matchesVerified && matchesAvailable;
  });
}

function renderStats() {
  const statsGrid = document.getElementById('statsGrid');
  const data = {
    ...state.dashboard,
    ...(state.analytics ? { carbonSavings: state.analytics.carbonSavings } : {}),
  };
  statsGrid.innerHTML = Object.entries(summaryLabels)
    .map(([key, label]) => `
      <div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${data[key] != null ? data[key] : '—'}</div>
      </div>
    `)
    .join('');
}

function renderNotifications() {
  const notificationsPanel = document.getElementById('notificationsPanel');
  if (!notificationsPanel) return;
  if (!state.notifications.length) {
    notificationsPanel.innerHTML = '<div class="result-card">No new alerts right now.</div>';
    return;
  }
  notificationsPanel.innerHTML = state.notifications
    .map((note) => `
      <div class="result-card">
        <div class="result-head">
          <div>
            <strong>${note.title}</strong>
            <div class="muted">${note.detail}</div>
          </div>
          <span class="badge ${note.kind === 'booking' ? 'verified' : note.kind === 'approval' ? 'pending' : 'muted'}">${note.kind}</span>
        </div>
      </div>
    `)
    .join('');
}

function renderMatchResults() {
  const results = document.getElementById('matchResults');
  const sortInput = document.getElementById('sortInput');
  const query = {
    resourceType: document.getElementById('resourceType').value,
    cluster: document.getElementById('clusterInput').value,
    budget: Number(document.getElementById('budgetInput').value) || 999999,
    deadline: document.getElementById('deadlineInput').value,
    search: document.getElementById('searchInput').value,
  };
  const filtered = getFilteredResources();
  const scored = filtered.map((resource) => ({ ...resource, match: scoreMatch(resource, query) }));
  scored.sort((a, b) => {
    if (sortInput.value === 'price') return a.pricePerDay - b.pricePerDay;
    if (sortInput.value === 'rating') return b.rating - a.rating;
    return b.match.score - a.match.score;
  });
  if (!scored.length) {
    results.innerHTML = '<div class="result-card">No matching resources found. Adjust your criteria or list a new resource.</div>';
    return;
  }
  results.innerHTML = scored.map((resource) => `
    <div class="result-card">
      <div class="result-head">
        <div>
          <strong>${resource.name}</strong>
          <div class="muted">${resource.category} • ${resource.cluster}</div>
          <div class="muted">${resource.description}</div>
        </div>
        <div>
          <span class="badge ${resource.verified ? 'verified' : 'unverified'}">${resource.verified ? 'Verified' : 'Unverified'}</span>
          <div class="muted">⭐ ${resource.rating}</div>
        </div>
      </div>
      <div class="score-meter">
        <div>Match score: <strong>${resource.match.score}%</strong></div>
        <div class="score-fill" style="width:${resource.match.score}%"></div>
        <div class="match-breakdown">
          <div>Category fit: ${resource.match.breakdown.categoryFit.toFixed(2)}</div>
          <div>Location proximity: ${resource.match.breakdown.locationFit.toFixed(2)}</div>
          <div>Cost fit: ${resource.match.breakdown.costFit.toFixed(2)}</div>
          <div>Availability: ${resource.match.breakdown.availabilityFit.toFixed(2)}</div>
          <div>Verified: ${resource.match.breakdown.verificationBonus.toFixed(2)}</div>
          <div>Deadline: ${resource.match.breakdown.deadlineFit.toFixed(2)}</div>
          <div>Compatibility: ${resource.match.breakdown.compatibilityFit.toFixed(2)}</div>
        </div>
      </div>
      <div class="result-head" style="margin-top:10px;">
        <div><strong>₹${resource.pricePerDay}</strong>/day</div>
        <div>
          <button class="secondary" data-add-cart="${resource.id}" type="button">Add to cart</button>
          <button class="primary" data-quick-book="${resource.id}" type="button">Quick book</button>
        </div>
      </div>
    </div>
  `).join('');
}

function renderMap() {
  const map = document.getElementById('mapVisual');
  const directoryClusters = state.clusters.length
    ? state.clusters
    : [...new Set(state.resources.map((resource) => resource.cluster))].map((name) => ({ name, city: '' }));
  const knownClusters = new Set(directoryClusters.map((cluster) => cluster.name));
  const clusters = [
    ...directoryClusters,
    ...state.resources
      .filter((resource) => !knownClusters.has(resource.cluster))
      .map((resource) => ({ name: resource.cluster, city: '' })),
  ];
  const active = state.clusterFilter || document.getElementById('clusterInput').value || '';
  map.innerHTML = clusters.map((cluster) => {
    const count = state.resources.filter((r) => r.cluster === cluster.name).length;
    const city = cluster.city ? ` · ${cluster.city}` : '';
    return `<button class="cluster-node ${cluster.name === active ? 'active' : ''}" data-cluster="${cluster.name}">${cluster.name}<br><span>${count} resources${city}</span></button>`;
  }).join('');
}

function renderAdminQueue() {
  const adminQueue = document.getElementById('adminQueue');
  const pending = state.resources.filter((r) => !r.verified);
  if (!pending.length) {
    adminQueue.innerHTML = '<div class="result-card">No pending reviews. Network is secure and current.</div>';
    return;
  }
  adminQueue.innerHTML = pending.map((resource) => `
    <div class="result-card">
      <div class="result-head">
        <div>
          <strong>${resource.name}</strong>
          <div class="muted">${resource.category} • ${resource.cluster}</div>
        </div>
        <span class="badge pending">Pending verification</span>
      </div>
      <div class="muted">${resource.description}</div>
      <div style="margin-top:10px; display:flex; gap:8px;">
        <button class="primary" data-approve="${resource.id}" type="button">Approve</button>
        <button class="secondary" data-reject="${resource.id}" type="button">Reject</button>
      </div>
    </div>
  `).join('');
}

function renderOwnerListings() {
  const ownerListings = document.getElementById('ownerListings');
  const ownerResources = state.resources.filter((r) => r.ownerId === getCurrentOwnerId());
  if (!ownerResources.length) {
    ownerListings.innerHTML = '<div class="result-card">You have not listed resources yet. Use the form above to add one.</div>';
    return;
  }
  ownerListings.innerHTML = ownerResources.map((resource) => `
    <div class="result-card">
      <div class="result-head">
        <div>
          <strong>${resource.name}</strong>
          <div class="muted">${resource.cluster} • ₹${resource.pricePerDay}/day</div>
        </div>
        <span class="badge ${resource.verified ? 'verified' : 'unverified'}">${resource.verified ? 'Verified' : 'Unverified'}</span>
      </div>
      <div class="muted">Availability <strong>${resource.availability ? 'Open' : 'Paused'}</strong></div>
      <div style="margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <label style="min-width:140px;">Price<input data-edit-price="${resource.id}" type="number" value="${resource.pricePerDay}" /></label>
        <label><input data-toggle-avail="${resource.id}" type="checkbox" ${resource.availability ? 'checked' : ''} /> Available</label>
        <button class="secondary" data-remove-resource="${resource.id}" type="button">Remove</button>
      </div>
    </div>
  `).join('');
}

function renderBookingOptions() {
  const select = document.getElementById('quickBookingSelect');
  const verifiedResources = state.resources.filter((r) => r.verified && r.availability);
  select.innerHTML = ['<option value="">Choose a resource</option>']
    .concat(verifiedResources.map((resource) => `<option value="${resource.id}">${resource.name} — ₹${resource.pricePerDay}/day</option>`))
    .join('');
  const quickBookButton = document.getElementById('quickBookBtn');
  quickBookButton.disabled = !verifiedResources.length || !select.value;
  const cartList = document.getElementById('cartList');
  const submitBundleButton = document.getElementById('submitBundleBtn');
  submitBundleButton.disabled = !state.cart.length;
  if (!state.cart.length) {
    cartList.innerHTML = '<div class="cart-item">Your bundle is empty. Add a few resources from the match results.</div>';
    return;
  }
  cartList.innerHTML = state.cart.map((resourceId) => {
    const resource = state.resources.find((r) => r.id === resourceId);
    return `<div class="cart-item">${resource?.name || resourceId} — ₹${resource?.pricePerDay || 0}/day</div>`;
  }).join('');
}

function renderBookings() {
  const history = document.getElementById('bookingHistory');
  if (!state.bookings.length) {
    history.innerHTML = '<div class="result-card">No booking history yet.</div>';
    return;
  }
  history.innerHTML = state.bookings.map((booking) => {
    const resourceNames = booking.resources.map((rid) => state.resources.find((r) => r.id === rid)?.name || rid).join(', ');
    return `
      <div class="result-card">
        <div class="result-head">
          <div>
            <strong>${booking.id}</strong>
            <div class="muted">${resourceNames}</div>
          </div>
          <span class="badge ${booking.status === 'Completed' ? 'verified' : 'pending'}">${booking.status}</span>
        </div>
        <div class="muted">Buyer: ${booking.buyer} • Total: ₹${booking.total} • Created: ${booking.created}</div>
        <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
          ${booking.status !== 'Completed' ? `<button class="primary" data-complete-booking="${booking.id}" type="button">Mark complete</button>` : ''}
          ${booking.status === 'Completed' && booking.rating == null ? `<label>Rate this delivery<input data-rate-booking="${booking.id}" type="number" min="1" max="5" value="5" /></label>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderAnalytics() {
  const categoryChart = document.getElementById('categoryChart');
  const trendChart = document.getElementById('trendChart');
  const { categories, listed, demand, trendLabels, trend } = state.analytics;
  categoryChart.innerHTML = categories.map((cat, index) => `
    <div class="chart-column">
      <div class="bar listed-bar" style="height:${Math.max(35, listed[index] * 22)}px" title="Listed: ${listed[index]}"><span>${listed[index]}</span></div>
      <div class="bar demand-bar" style="height:${Math.max(35, demand[index] * 22)}px" title="Demand: ${demand[index]}"><span>${demand[index]}</span></div>
      <div class="chart-label">${cat}</div>
    </div>
  `).join('');
  trendChart.innerHTML = trendLabels.map((month, index) => `
    <div class="chart-column">
      <div class="bar trend-bar" style="height:${Math.max(35, trend[index] * 28)}px" title="Bookings: ${trend[index]}"><span>${trend[index]}</span></div>
      <div class="chart-label">${month}</div>
    </div>
  `).join('');
}

async function submitResource() {
  const payload = {
    name: document.getElementById('listName').value,
    category: document.getElementById('listCategory').value,
    cluster: document.getElementById('listCluster').value,
    pricePerDay: Number(document.getElementById('listPrice').value),
    ownerId: getCurrentOwnerId(),
    ownerName: 'Current MSME',
    description: document.getElementById('listDescription').value,
    tags: [document.getElementById('listCategory').value.toLowerCase(), document.getElementById('listCluster').value.toLowerCase()],
  };
  await fetchJson('/api/resources', { method: 'POST', body: JSON.stringify(payload) });
  await Promise.all([loadResources(), loadDashboard(), loadNotifications(), loadAnalytics()]);
  render();
}

async function patchResource(resourceId, updates) {
  await fetchJson(`/api/resources/${resourceId}`, { method: 'PATCH', body: JSON.stringify(updates) });
  await Promise.all([loadResources(), loadDashboard(), loadNotifications(), loadAnalytics()]);
  render();
}

async function removeResource(resourceId) {
  await fetchJson(`/api/resources/${resourceId}`, { method: 'DELETE' });
  await Promise.all([loadResources(), loadDashboard(), loadNotifications(), loadAnalytics()]);
  render();
}

async function submitBooking(resourceIds, buyerName = 'Demo Buyer') {
  await fetchJson('/api/bookings', { method: 'POST', body: JSON.stringify({ resourceIds, buyer: buyerName }) });
  await Promise.all([loadBookings(), loadResources(), loadDashboard(), loadNotifications(), loadAnalytics()]);
  state.cart = [];
  render();
}

async function updateBookingStatus(bookingId, action, rating) {
  await fetchJson(`/api/bookings/${bookingId}`, { method: 'PATCH', body: JSON.stringify({ action, rating }) });
  await Promise.all([loadBookings(), loadResources(), loadDashboard(), loadNotifications(), loadAnalytics()]);
  render();
}

function addBookingToCart(resourceId) {
  if (!state.cart.includes(resourceId)) {
    state.cart.push(resourceId);
  }
}

function bindEvents() {
  document.getElementById('roleSwitch').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-role]');
    if (!button) return;
    document.querySelectorAll('.role-btn').forEach((btn) => btn.classList.remove('active'));
    button.classList.add('active');
    state.currentRole = button.dataset.role;
    render();
  });

  document.getElementById('matchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    renderMatchResults();
  });

  document.getElementById('matchForm').addEventListener('input', () => {
    renderMatchResults();
  });

  document.getElementById('listForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitResource();
    event.target.reset();
  });

  document.getElementById('quickBookBtn').addEventListener('click', async () => {
    const resourceId = document.getElementById('quickBookingSelect').value;
    if (resourceId) {
      await submitBooking([resourceId], 'Demo Buyer');
      document.getElementById('quickBookingSelect').value = '';
      renderBookingOptions();
    }
  });

  document.getElementById('clusterInput').addEventListener('input', () => {
    state.clusterFilter = document.getElementById('clusterInput').value.trim();
    renderMatchResults();
    renderMap();
  });

  document.getElementById('verifiedOnly').addEventListener('change', (event) => {
    state.verifiedOnly = event.target.checked;
    renderMatchResults();
  });

  document.getElementById('availableOnly').addEventListener('change', (event) => {
    state.availableOnly = event.target.checked;
    renderMatchResults();
  });

  document.getElementById('resetFiltersBtn').addEventListener('click', () => {
    document.getElementById('resourceType').value = '';
    document.getElementById('clusterInput').value = '';
    document.getElementById('budgetInput').value = 9999;
    document.getElementById('deadlineInput').value = '';
    document.getElementById('searchInput').value = '';
    document.getElementById('sortInput').value = 'score';
    document.getElementById('verifiedOnly').checked = false;
    document.getElementById('availableOnly').checked = false;
    state.clusterFilter = '';
    state.verifiedOnly = false;
    state.availableOnly = false;
    renderMatchResults();
    renderMap();
  });

  document.getElementById('addToCartBtn').addEventListener('click', () => {
    const visibleMatch = document.querySelector('#matchResults .result-card');
    const btn = visibleMatch?.querySelector('[data-add-cart]');
    if (btn) {
      addBookingToCart(btn.dataset.addCart);
      renderBookingOptions();
    }
  });

  document.getElementById('submitBundleBtn').addEventListener('click', async () => {
    if (!state.cart.length) return;
    await submitBooking([...state.cart], 'Bundle Buyer');
  });

  document.addEventListener('click', async (event) => {
    const approveButton = event.target.closest('[data-approve]');
    if (approveButton) {
      await patchResource(approveButton.dataset.approve, { verified: true });
      return;
    }

    const rejectButton = event.target.closest('[data-reject]');
    if (rejectButton) {
      await patchResource(rejectButton.dataset.reject, { verified: false });
      return;
    }

    const removeButton = event.target.closest('[data-remove-resource]');
    if (removeButton) {
      await removeResource(removeButton.dataset.removeResource);
      return;
    }

    const priceInput = event.target.closest('[data-edit-price]');
    if (priceInput) {
      await patchResource(priceInput.dataset.editPrice, { pricePerDay: Number(priceInput.value) });
      return;
    }

    const toggle = event.target.closest('[data-toggle-avail]');
    if (toggle) {
      await patchResource(toggle.dataset.toggleAvail, { availability: toggle.checked });
      return;
    }

    const quickBook = event.target.closest('[data-quick-book]');
    if (quickBook) {
      await submitBooking([quickBook.dataset.quickBook], 'Demo Buyer');
      return;
    }

    const addCart = event.target.closest('[data-add-cart]');
    if (addCart) {
      addBookingToCart(addCart.dataset.addCart);
      renderBookingOptions();
      return;
    }

    const completeBooking = event.target.closest('[data-complete-booking]');
    if (completeBooking) {
      await updateBookingStatus(completeBooking.dataset.completeBooking, 'complete');
      return;
    }
  });

  document.addEventListener('change', async (event) => {
    const rateInput = event.target.closest('[data-rate-booking]');
    if (rateInput) {
      await updateBookingStatus(rateInput.dataset.rateBooking, 'rate', Number(rateInput.value));
    }
  });

  document.getElementById('mapVisual').addEventListener('click', (event) => {
    const node = event.target.closest('[data-cluster]');
    if (!node) return;
    state.clusterFilter = node.dataset.cluster;
    document.getElementById('clusterInput').value = node.dataset.cluster;
    renderMatchResults();
    renderMap();
  });

  document.getElementById('quickBookingSelect').addEventListener('change', (event) => {
    document.getElementById('quickBookBtn').disabled = !event.target.value;
  });

  document.getElementById('productionPlannerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitProductionPlan();
  });

  // live suggestions while typing processes
  const processesInput = document.getElementById('productProcesses');
  if (processesInput) {
    processesInput.addEventListener('input', () => {
      renderProcessSuggestions();
    });
    // initial render
    renderProcessSuggestions();
  }

  document.getElementById('demoModeBtn').addEventListener('click', async () => {
    await runDemoScenario();
  });
}

async function submitProductionPlan() {
  const payload = {
    productName: document.getElementById('productName').value,
    quantity: Number(document.getElementById('productQuantity').value),
    material: document.getElementById('productMaterial').value,
    processes: document.getElementById('productProcesses').value,
    deadline: Number(document.getElementById('productDeadline').value),
    budget: Number(document.getElementById('productBudget').value),
    cluster: document.getElementById('productCluster').value,
    quality: document.getElementById('productQuality').value,
    transport: 'Standard',
  };
  state.productionPlan = await fetchJson('/api/production/plan', { method: 'POST', body: JSON.stringify(payload) });
  renderProductionPlan();
}

async function runDemoScenario() {
  document.getElementById('productName').value = 'Aluminium Bracket';
  document.getElementById('productQuantity').value = 2000;
  document.getElementById('productMaterial').value = 'Aluminium';
  document.getElementById('productProcesses').value = 'CNC machining, Surface finishing, Quality inspection, Logistics';
  document.getElementById('productDeadline').value = 5;
  document.getElementById('productBudget').value = 100000;
  document.getElementById('productCluster').value = 'Coimbatore';
  document.getElementById('productQuality').value = 'High';
  await submitProductionPlan();
}

function renderProductionPlan() {
  const result = document.getElementById('productionPlanResult');
  if (!state.productionPlan) {
    result.innerHTML = '<div class="result-card">Use the production planner to build an intelligent resource chain.</div>';
    return;
  }
  const plan = state.productionPlan.bundle;
  const capabilities = plan.capabilities.map((cap) => `<span class="badge verified">${cap}</span>`).join(' ');
  const chainHtml = plan.chain.length
    ? plan.chain.map((item) => `
      <div class="result-card">
        <div class="result-head">
          <div>
            <strong>${item.capability}</strong>
            <div class="muted">${item.resource.name} • ${item.resource.cluster} • ${item.resource.ownerName}</div>
          </div>
          <span class="badge verified">${item.scoreBreakdown.score}%</span>
        </div>
        <div class="muted">₹${item.resource.pricePerDay}/day • Rating ${item.resource.rating} • ${item.resource.verified ? 'Verified' : 'Unverified'}</div>
        <div class="match-breakdown">
          <div>Capability: ${item.scoreBreakdown.capabilityCompatibility}%</div>
          <div>Location: ${item.scoreBreakdown.locationProximity}%</div>
          <div>Cost: ${item.scoreBreakdown.costEfficiency}%</div>
          <div>Capacity: ${item.scoreBreakdown.capacityAvailable}%</div>
          <div>Health: ${item.scoreBreakdown.health}%</div>
          <div>Reliability: ${item.scoreBreakdown.reliability}%</div>
          <div>Transport: ${item.scoreBreakdown.transportation}%</div>
          <div>Deadline: ${item.scoreBreakdown.deadlineCompatibility}%</div>
        </div>
      </div>
    `).join('')
    : '<div class="result-card">No matching resource chain was found for the requirement.</div>';
  const optionsHtml = plan.options.map((option) => `
    <div class="result-card">
      <div class="result-head">
        <div><strong>${option.label}</strong></div>
        <span class="badge ${option.risk === 'LOW' ? 'verified' : option.risk === 'MEDIUM' ? 'pending' : 'unverified'}">${option.risk}</span>
      </div>
      <div class="muted">Total: ₹${option.estimatedTotal}, Duration: ${option.estimatedDuration} days, Transport: ₹${option.estimatedTransport}</div>
    </div>
  `).join('');
  const decisionsHtml = (plan.decisionAnalysis || []).map((decision) => `
    <div class="result-card">
      <strong>${decision.option}</strong>
      <div class="muted">Estimated cost: ₹${decision.estimatedCost} · Estimated time: ${decision.estimatedDays} days</div>
      <div class="muted">${decision.assumption}</div>
    </div>
  `).join('');
  result.innerHTML = `
    <div class="result-card">
      <div class="result-head">
        <div>
          <strong>Production requirement analyzed</strong>
          <div class="muted">${state.productionPlan.requirements.productName} • ${state.productionPlan.requirements.quantity} units • ${state.productionPlan.requirements.material}</div>
        </div>
        <span class="badge ${plan.feasible ? 'verified' : 'unverified'}">${plan.feasible ? 'Feasible' : 'Review'}</span>
      </div>
      <div class="muted">Required capabilities:</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">${capabilities}</div>
      <div style="margin-top:12px;"><strong>Recommended chain</strong></div>
      ${chainHtml}
      <div style="margin-top:12px;"><strong>Bundle alternatives</strong></div>
      ${optionsHtml}
      <div style="margin-top:12px;"><strong>Estimated decision analysis</strong></div>
      ${decisionsHtml}
      ${plan.feasible ? '<button class="primary" id="bookPlanBundleBtn" type="button">Book recommended bundle</button>' : ''}
    </div>
  `;
  const bookButton = document.getElementById('bookPlanBundleBtn');
  if (bookButton) {
    bookButton.addEventListener('click', async () => {
      const ids = plan.chain.map((item) => item.resource.id);
      if (ids.length) {
        await submitBooking(ids, 'Planner Buyer');
      }
    });
  }
}

function inferCapabilitiesFromProcesses(text) {
  const lowers = (text || '').toLowerCase();
  const caps = new Set();
  if (!lowers) return [];
  if (/cnc|lathe|mill|machin/.test(lowers)) caps.add('CNC Machining');
  if (/finish|coating|paint|surface/.test(lowers)) caps.add('Surface Finishing');
  if (/inspect|quality|cmm|testing|lab/.test(lowers)) caps.add('Quality Inspection');
  if (/operator|skilled|manpower/.test(lowers)) caps.add('Skilled Operator');
  if (/truck|logist|transport|forklift/.test(lowers)) caps.add('Logistics');
  if (/warehouse|storage/.test(lowers)) caps.add('Storage');
  if (!caps.size) {
    // fallback: guess CNC Machining as default
    caps.add('CNC Machining');
  }
  return Array.from(caps);
}

function countResourcesForCapability(capability) {
  if (!state.resources || !state.resources.length) return 0;
  const key = capability.toLowerCase();
  return state.resources.reduce((acc, r) => {
    const hay = `${r.name} ${r.description} ${(r.tags||[]).join(' ')}`.toLowerCase();
    return acc + (hay.includes(key) || (r.category || '').toLowerCase().includes(key) ? 1 : 0);
  }, 0);
}

function renderProcessSuggestions() {
  const input = document.getElementById('productProcesses');
  const suggest = document.getElementById('productProcessesSuggestions');
  if (!input || !suggest) return;
  const text = input.value;
  const caps = inferCapabilitiesFromProcesses(text);
  if (!caps.length) {
    suggest.innerHTML = '';
    return;
  }
  // For each capability, show top 3 matching resources as thumbnails
  suggest.innerHTML = caps.map((cap) => {
    const count = countResourcesForCapability(cap);
    const top = getTopResourcesForCapability(cap, 3);
    const thumbs = top.map((r) => `
      <div style="display:flex;gap:8px;align-items:center;">
        <div class=\"suggestion-thumb\">${(r.name||'').split(' ').slice(0,2).map(s=>s[0]).join('').toUpperCase()}</div>
        <div class=\"suggestion-info\"><div class=\"suggestion-name\">${r.name}</div><div class=\"suggestion-sub\">${r.cluster} • ₹${r.pricePerDay}</div></div>
      </div>
    `).join('');
    return `
      <div class="suggestion-item" data-cap="${cap}">
        <div style="flex:0 0 auto; display:flex; flex-direction:column; gap:6px;">
          <div style="font-weight:700">${cap}</div>
          <div class="suggestion-sub">${count} matches</div>
        </div>
        <div style="flex:1 1 auto; display:flex; gap:8px; justify-content:flex-end;">${thumbs}</div>
      </div>
    `;
  }).join('');
  // attach handlers
  suggest.querySelectorAll('.suggestion-item').forEach((el) => {
    el.addEventListener('click', (ev) => {
      // if clicking a child that is a thumb, still treat as suggestion click
      const cap = el.dataset.cap;
      const cur = input.value.split(',').map(s=>s.trim()).filter(Boolean);
      if (!cur.includes(cap)) cur.push(cap);
      input.value = cur.join(', ');
      renderProcessSuggestions();
      ev.stopPropagation();
    });
  });
}

function getTopResourcesForCapability(capability, limit = 3) {
  const key = capability.toLowerCase();
  const candidates = state.resources.map(r => ({
    ...r,
    scoreRank: ((r.verified?1:0) * 100) + (r.rating || 0)
  })).filter(r => {
    const inCaps = (r.capabilities || []).map(c=>c.toLowerCase()).includes(key);
    const inText = `${r.name} ${r.description} ${(r.tags||[]).join(' ')}`.toLowerCase().includes(key);
    return inCaps || inText;
  }).sort((a,b) => b.scoreRank - a.scoreRank);
  return candidates.slice(0, limit);
}

bindEvents();
init();
