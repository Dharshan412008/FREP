# FREP — Factory Resource Exchange Platform

FREP is a React, Flask, and SQLite marketplace where Indian MSMEs discover, match, book, and verify shared industrial capacity. Buyers can search and plan production, owners manage their own listings, and admins review listing verification.

## React experience

- **Industrial exchange-floor design:** a responsive carbon, mineral, amber, and teal visual system replaces the original prototype UI, with accessible light/dark themes and reduced-motion support.
- **Role-shaped workspaces:** Buyers get Exchange, production planning, cluster network, bookings, and intelligence; Owners get portfolio creation and controls; Admins get an evidence-led verification desk.
- **Explainable, interactive discovery:** natural-language search, filters, live Compose fields, match factors, quick booking, and a sticky multi-resource bundle tray share one grounded marketplace flow.
- **Operational views:** native SVG network and analytics visualizations, a capability-chain planner, booking timelines, owner listing controls, live notifications, and a keyboard-accessible Copilot drawer work without a client-side routing dependency.

## Agentic Copilot features (Tiers 1, 2, and 3)

- **FREP Agentic Copilot — Compose:** live completions, confidence-scored field extraction, and a grounded top-three resource shortlist in search, production planning, and new-listing workflows.
- **FREP Agentic Copilot — Act:** buyers can turn procurement language into a grounded search or draft bundled booking; owners can draft listings. A write happens only after a visible review and explicit confirmation click using a signed, expiring, one-login token.
- **FREP Agentic Copilot — Voice:** search and planner controls use the browser Web Speech API with English, Hindi, Tamil, and Telugu choices. Interim transcripts feed the same Compose pipeline, whose local manufacturing vocabulary normalizes common terms in all four languages; unsupported browsers retain the complete typed workflow.
- **Free local intelligence:** the deterministic local parser and hybrid TF-IDF + deterministic subword ranker work without a paid key or model download. A browser Web Worker can use a small quantized model through WebGPU, with WASM fallback, while optional `GROQ_API_KEY` or `GEMINI_API_KEY` values only enhance the experience.
- **Non-blocking quality cascade:** Compose renders locally first, then optionally upgrades its ghost text over a cancellable Server-Sent Events stream when a free-tier cloud key is configured.
- **Explainable matching:** search, planner, and typeahead results include a one-line reason plus factor weights, contributions, and top drivers.
- **Right-sized authentication:** hashed demo passwords, signed cookie sessions, and server-enforced Buyer, Owner, and Admin boundaries. Client-supplied roles, owner IDs, and buyer names are not trusted.
- **Realtime updates:** authenticated Server-Sent Events refresh availability, booking, verification, and notification views without a polling dependency.
- **Installable and offline-safe:** the service worker caches the shell and an explicit allowlist of public catalogue/aggregate reads. Sessions, bookings, notifications, prompts, event streams, and writes are never cached; offline mode is clearly read-only.
- **Safe migration:** startup adds Tier 1/2 tables and columns to an existing SQLite database without dropping legacy data.
- **Progressive WebMCP:** supported experimental Chrome builds receive small, schema-defined FREP tools for catalogue discovery and booking review. The current `document.modelContext` API is preferred, with legacy `navigator.modelContext` fallback; unsupported browsers use the normal app unchanged. No WebMCP tool confirms a write.
- **Measured analytics:** booking trends come from stored booking dates, and the sustainability card is a reproducible CO2e estimate based on booked-resource utilization and an explicitly labelled distance model instead of a fixed value per booking.
- **Judge-friendly deployment and theme:** `docker compose up --build` starts the complete app with persistent SQLite storage, while the accessible dark/light toggle remembers the browser's choice.

## Demo accounts

| Role | Username | Password | Allowed workflow |
| --- | --- | --- | --- |
| Buyer | `buyer` | `buyer123` | Search, Compose, Voice, Act, plan, book, complete, and rate |
| Owner | `owner` | `owner123` | Compose, Voice, Act, and create/update/remove listings owned by `O-100` |
| Admin | `admin` | `admin123` | Approve or reject listing verification |

These credentials are intentionally local-demo credentials, not production secrets.

## Requirements and installation

- Python 3.10 or newer
- Node.js 20 or newer with npm (for React development and local production builds)
- A modern browser; WebGPU is used when available and WASM is the fallback

Install the existing Python dependencies:

```powershell
python -m pip install -r requirements.txt
```

Install the locked React dependencies:

```powershell
npm --prefix frontend ci
```

Tiers 1 through 3 add no separate Python package requirement to the direct run: Flask already installs the signed-token/session and password-hashing dependencies used here. The Docker image additionally installs Gunicorn as its production-style process runner.

## Run

Build the React app, then start the API and production-style web server:

```powershell
npm --prefix frontend run build
python server.py
```

Open `http://127.0.0.1:8000`, sign in with a demo account, and use search, planner, or owner listing text to try Compose. Flask serves `frontend/dist/index.html` and its content-hashed assets when the build exists. If `frontend/dist` is absent, the legacy root `index.html`, `app.js`, and `styles.css` remain a safe compatibility fallback.

For frontend development with hot module replacement, keep Flask running in one terminal and start Vite in another:

```powershell
# Terminal 1
python server.py

# Terminal 2
npm --prefix frontend run dev
```

Open `http://127.0.0.1:5173` during development. Vite proxies `/api` and the stable PWA/worker routes to Flask on port 8000. Voice remains a browser capability. Service-worker/offline testing should use the production build served by Flask and needs one successful online load first.

To choose another port in PowerShell:

```powershell
$env:FREP_PORT=8001
python server.py
```

To keep signed sessions stable across server restarts, set a private local secret before starting FREP:

```powershell
$env:FREP_SECRET_KEY='replace-with-a-long-local-secret'
python server.py
```

The default database is `frep.db`. Automated tests set `FREP_DB_PATH` before importing the server and never modify that file.

### Docker

With Docker Desktop or Docker Engine plus Compose installed, start the complete app in one command:

```powershell
docker compose up --build
```

Open `http://127.0.0.1:8000`. The Dockerfile builds the React application in an isolated Node stage, copies only `frontend/dist` into the non-root Python/Gunicorn runtime, and does not ship Node or `node_modules` in the final image. Compose stores SQLite data in the named `frep_data` volume and supplies a local-demo signing secret. For a shared or production-like environment, set your own long `FREP_SECRET_KEY` before starting Compose. The local `frep.db`, credentials, tests, reports, and generated frontend output are excluded from the build context.

### Frontend architecture

- `frontend/src/App.jsx` owns authenticated, role-aware workspace navigation and coordinates Buyer, Owner, and Admin actions.
- `frontend/src/pages/` contains the dashboard, marketplace, production planner, network, booking, listing, analytics, and verification experiences.
- `frontend/src/lib/api.js` is the same-origin API boundary; it includes credentials and normalizes Flask errors. `frontend/src/hooks/useWorkspace.js` hydrates shared data and refreshes it from authenticated server-sent events.
- `frontend/src/components/CopilotDrawer.jsx` keeps Ask and Act flows available across the workspace while preserving explicit server-confirmed writes.
- Vite emits content-hashed bundles to `frontend/dist/assets`. Flask serves only that directory at `/assets/*`, caches those immutable files, and revalidates the HTML shell so a new deployment picks up the latest hashes.

### Analytics methodology

The analytics endpoint keeps its original response keys while adding transparent breakdowns and assumptions:

- Demand counts unique referenced resources in non-draft, non-cancelled bookings. The four-month trend uses stored booking dates and ends at the latest parseable booking month, so historical databases remain reproducible.
- Realized impact includes completed bookings only; active bookings are a separate projection. For each resource allocation, the prototype calculates `category capacity credit × utilization − estimated transport emissions`, floors the displayed aggregate at zero, and reports the components.
- Utilization comes from the recorded percentage, then from total versus available capacity, then a disclosed 50% fallback. Category credits are 96 kg for machinery, 36 kg for warehouse space, 48 kg for testing equipment, 30 kg for logistics vehicles, zero for skilled operators, and 24 kg for other physical categories.
- Route kilometres are not stored. FREP therefore labels distance as a proxy: recorded transport rate divided by an assumed ₹30/km, with a ₹1,200 default, then multiplied by 0.18 kgCO2e/km. This is a planning estimate, not measured emissions or an audited life-cycle assessment.

## Test

Run the complete isolated test suite, including Tier 1/2/3 migration, auth, authorization, Compose, Act, confirmation safety, SSE, semantic, WebMCP, analytics, theme, container-policy, PWA-policy, explanation, compatibility, and strict live-script contract tests (it creates a temporary legacy-shaped database and uses mocks for the live-script failure paths):

```powershell
python -m unittest discover -v
```

The authenticated integration gate is stateful: it creates a completed/rated booking and notifications, although it removes its temporary resource listing. Run the server with a disposable database, for example in one PowerShell window:

```powershell
$env:FREP_DB_PATH="$env:TEMP\frep-integration-$PID.db"
$env:FREP_PORT=8001
python server.py
```

Then run the strict three-role create/update/verify/book/complete/rate/delete workflow from another PowerShell window. It exits nonzero on any unexpected status, identity, or response contract:

```powershell
$env:FREP_BASE_URL='http://127.0.0.1:8001'
python integration_test.py
```

If the server uses another port, point both live scripts at it first, for example: `$env:FREP_BASE_URL='http://127.0.0.1:8001'`.

With the server running, use the strict legacy-compatible API health/response-contract gate. It checks HTTP 200, JSON content types, expected top-level response shapes, and health status for all six original read routes; it reports every failure and exits nonzero unless all checks pass. The unauthenticated bookings route intentionally returns an empty list—signed-in buyers receive only their own records.

```powershell
python check_api_endpoints.py
```

### Verification status (9 September 2026)

- **Automated suite: passed.** All 31 tests pass: the 23 Tier 1/2/3 tests cover migrations, authentication and authorization, Compose, Act confirmation safety, SSE, semantic ranking, multilingual voice normalization, PWA policy, analytics, WebMCP, theme behavior, Docker policy, and backward compatibility; eight focused tests cover the strict public endpoint and authenticated integration gates.
- **Live API flows: passed.** `check_api_endpoints.py` validated HTTP 200 and the expected JSON contracts for all six public read endpoints and exited 0. The strict `integration_test.py` gate validated every expected status/payload in the three-role login, owner create/update/delete, admin verification, and buyer book/complete/rate flow, removed its temporary listing, and exited 0 against an isolated database. The checked-in `frep.db` was not used for this verification.
- **React production build: passed.** Vite transformed 1,590 modules and emitted content-hashed JavaScript and CSS bundles; Flask served both with the expected immutable one-year cache policy while revalidating the HTML shell.
- **Client and server static checks: passed.** The service worker parses, the manifest is valid JSON, and the Python application and live-check scripts compile.
- **Headless browser smoke: passed.** Installed Chrome rendered the React login and completed real Buyer, Owner, and Admin sign-ins. The Buyer desktop workspace and every Owner/Admin page at a 390 × 844 mobile viewport opened successfully; the mobile menu/logout flow worked, no page overflowed horizontally, and the run found zero same-origin browser exceptions, console warnings/errors, failed requests, or HTTP errors.
- **Docker runtime check: pending locally.** The automated Docker contract test passes, but an actual `docker compose` configuration/build/run check could not be performed because the Docker CLI is not installed in the current environment.
- **Manual device-capability demo: pending.** Microphone permission, install prompts, and a hands-on offline/realtime demonstration still depend on the presentation browser and operating system.

## Project map

- `server.py` — Flask API, additive SQLite migrations, sessions, permissions, matching, computed analytics, confirmed Act writes, SSE, booking, and planning
- `ai_engine.py` — local intent extraction, partial-text parsing, completion, hybrid TF-IDF/subword ranking, and optional cloud enhancement
- `copilot-worker.js` — cancellable browser-local quantized generation with WebGPU/WASM fallback
- `frontend/` — React 19 and Vite source for the role-aware workspace, responsive design system, pages, API client, live data hook, and Copilot drawer
- `app.js`, `index.html`, `styles.css` — preserved legacy client used when a React production build is not present
- `sw.js`, `manifest.json` — install metadata and guarded shell/public-catalogue offline caching
- `Dockerfile`, `compose.yaml`, `.dockerignore` — multi-stage React build and non-root one-command deployment with persistent SQLite data
- `test_tier1.py` — isolated Tier 1/2/3 behavior, safety, and backward-compatibility tests
- `test_check_api_endpoints.py` — isolated success/failure tests for the strict live public API gate
- `test_integration_check.py` — mocked success, failure, cleanup, and import-safety tests for the authenticated integration gate
- `integration_test.py` — strict stateful authenticated API workflow gate with listing cleanup
- `check_api_endpoints.py` — strict public API health/response-contract gate
- `generate_docx.py` — Word overview export

See [PROJECT_REQUIREMENTS.md](PROJECT_REQUIREMENTS.md) for the broader product workflows and cluster requirements.

## 60–90 second judge demo

Before presenting, load the app once online and ensure seeded resource `R-101` is available.

1. Start with `python server.py`, open `http://127.0.0.1:8000`, and sign in as `buyer` / `buyer123`. Say: “FREP’s product spine is still search, match, book, verify, and plan; the AI accelerates those workflows and needs no paid key.”
2. Open **Exchange**, choose **English**, click **Speak requirement**, and say: “Need a verified CNC in Peenya under nine thousand rupees next week.” Stop listening. Point to the live extracted fields, grounded shortlist, and match-factor explanation.
3. Open **Copilot**, enter “Find me 1 CNC machine in Peenya under Rs 9000 available next week,” and click **Draft action**. Say: “This is grounded in the live catalogue, but drafting is read-only.” Point to the warning/field review and enabled confirmation button.
4. Click **Confirm action** once. Say: “Only this explicit click submits the signed draft; the server rechecks role, ownership, verification, and availability, and blocks replay.” Point to the live availability/notification refresh.
5. Open **Intelligence**, toggle the sun/moon theme control, and point to the booking trend and impact-method card. Say: “These are stored booking counts, and the CO2e estimate exposes utilization, freight deduction, proxy distance, and its non-audited assumption.”
6. In browser developer tools, switch the network offline without refreshing and revisit **Exchange** or **Intelligence**. Say: “Previously loaded public capacity stays visible and FREP marks the workspace read-only; credentials, bookings, prompts, and notifications are never cached.” A full offline reload still serves the app shell, but reconnecting is required to validate the signed session again.

## Prototype scope

Authentication and signed Act confirmations are deliberately right-sized for a judging demo. A production deployment still needs HTTPS, managed secrets, CSRF protection, rate limiting, account recovery, a full security review, payments, and operational monitoring. Web Speech support and whether recognition itself uses a network service are browser-dependent. WebMCP remains an experimental Chrome capability and is an optional enhancement, never a runtime dependency.
