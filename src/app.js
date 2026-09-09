// ===== TIER 1: COMPOSE MODE (Live suggestions) =====
let suggestionTimeout;
const debounceTimeout = 300;

function showSuggestionPanel() {
  const input = document.getElementById('search-input');
  if (suggestionTimeout) clearTimeout(suggestionTimeout);
  suggestionTimeout = setTimeout(() => {
    const text = input.value;
    fetch(`/api/copilot/typeahead?text=${encodeURIComponent(text)}&role=${currentRole}`)
      .then(res => res.json())
      .then(data => {
        const panel = document.getElementById('suggestion-panel');
        panel.innerHTML = `
          <div class="suggestion">
            <span class="completion">${data.completion}</span>
            <div class="fields">
              ${Object.entries(data.fields).map(([key, value]) => 
                `<span class="field">${key}: ${value}</span>`
              ).join('')}
            </div>
            <div class="explanation">
              ${data.matches.length > 0 ? 
                `Why: ${getExplanation(data.matches[0])}` : 
                'No matches found'}
            </div>
          </div>
        `;
      });
  }, debounceTimeout);
}

// ===== TIER 1: EXPLAIN (Live) =====
function getExplanation(match) {
  return `Price fit: ${match.price_fit.toFixed(1)} | Cluster: ${match.cluster}, Verified: ${match.verified}`;
}

// ===== TIER 1: AUTH (Session-based) =====
const loginForm = document.getElementById('login-form');
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const role = document.getElementById('role').value;
  session = { role }; // Session-based auth (no DB changes)
  window.location.href = '/dashboard';
});

// ===== DEMO INTEGRATION =====
document.getElementById('search-input').addEventListener('input', showSuggestionPanel);