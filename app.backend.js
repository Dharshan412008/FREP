const BASE_URL = '';
const CURRENT_OWNER_ID = 'O-100';

const state = {
  currentRole: 'buyer',
  resources: [],
  bookings: [],
  notifications: [],
  dashboard: {},
  analytics: { categories: [], listed: [], demand: [], trendLabels: [], trend: [], carbonSavings: 0 },
  clusterFilter: '',
  cart: [],
};

const summaryLabels = {
  resources_listed: 'Resources listed',
  verified_msmes: 'Verified MSMEs',
  average_cost_per_day: 'Average cost/day',
  active_bookings: 'Active bookings',
  capex_avoided: 'Estimated capex avoided',
};

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return res.json();
}

async function init() {
  await Promise.all([loadDashboard(), loadResources(), loadBookings(), loadAnalytics(), loadNotifications()]);
  render();
}

async function loadDashboard() {
  state.dashboard = await fetchJson('/api/dashboard');
}

async function loadResources() {
  state.resources = await fetchJson('/api/resources');
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
  renderStats();
  renderMatchResults();
  renderMap();
  renderAdminQueue();
  renderOwnerListings();
  renderBookingOptions();
  renderBookings();
  renderAnalytics();
  updateRoleBadge();
  updateSectionVisibility();
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
  const cluster = document.getElementById('clusterInput').value;
  const budget = Number(document.getElementById('budgetInput').value) || 999999;
  const search = document.getElementById('searchInput').value;
  return state.resources.filter((resource) => {
    const matchesType = !resourceType || resource.category === resourceType || normalizeString(resource.name).includes(normalizeString(resourceType));
    const matchesCluster = !cluster || normalizeString(resource.cluster).includes(normalizeString(cluster));
    const matchesSearch = !search || normalizeString(`${resource.name} ${resource.category} ${resource.cluster} ${resource.tags.join(' ')}`).includes(normalizeString(search));
    const matchesBudget = resource.pricePerDay <= budget;
    return matchesType && matchesCluster && matchesSearch && matchesBudget;
  });
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
  const clusters = [...new Set(state.resources.map((resource) => resource.cluster))];
  const map = document.getElementById('mapVisual');
  const active = state.clusterFilter || document.getElementById('clusterInput').value || '';
  map.innerHTML = clusters.map((cluster) => {
    const count = state.resources.filter((r) => r.cluster === cluster).length;
    return `<button class="cluster-node ${cluster === active ? 'active' : ''}" data-cluster="${cluster}">${cluster}<br><span>${count} resources</span></button>`;
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
  select.innerHTML = verifiedResources.map((resource) => `<option value="${resource.id}">${resource.name} — ₹${resource.pricePerDay}/day</option>`).join('');
  const cartList = document.getElementById('cartList');
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
    <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:6px;">
      <div class="bar" style="height:${Math.max(35, listed[index] * 35)}px"><span>${listed[index]}</span></div>
      <div class="bar" style="height:${Math.max(35, demand[index] * 35)}px; background:linear-gradient(180deg, var(--amber), var(--danger));"><span>${demand[index]}</span></div>
      <div class="muted" style="font-size:0.72rem; text-align:center;">${cat}</div>
    </div>
  `).join('');
  trendChart.innerHTML = trendLabels.map((month, index) => `
    <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:6px;">
      <div class="bar" style="height:${Math.max(35, trend[index] * 40)}px"><span>${trend[index]}</span></div>
      <div class="muted" style="font-size:0.72rem;">${month}</div>
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
  await Promise.all([loadResources(), loadDashboard(), loadAnalytics()]);
  render();
}

async function removeResource(resourceId) {
  await fetchJson(`/api/resources/${resourceId}`, { method: 'DELETE' });
  await Promise.all([loadResources(), loadDashboard(), loadAnalytics()]);
  render();
}

async function submitBooking(resourceIds, buyerName = 'Demo Buyer') {
  await fetchJson('/api/bookings', { method: 'POST', body: JSON.stringify({ resourceIds, buyer: buyerName }) });
  await Promise.all([loadBookings(), loadResources(), loadDashboard(), loadAnalytics()]);
  state.cart = [];
  render();
}

async function updateBookingStatus(bookingId, action, rating) {
  await fetchJson(`/api/bookings/${bookingId}`, { method: 'PATCH', body: JSON.stringify({ action, rating }) });
  await Promise.all([loadBookings(), loadResources(), loadDashboard(), loadAnalytics()]);
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
    if (resourceId) await submitBooking([resourceId], 'Demo Buyer');
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
}

bindEvents();
init();
