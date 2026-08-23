# FREP — Factory Resource Exchange Platform

A prototype Flask + vanilla JavaScript application for a shared MSME resource marketplace. Buyers, resource owners, and network admins can browse, match, book, verify, and analyze industrial asset sharing.

## What's included

- `server.py` — Flask backend with SQLite persistence
- `app.js` — frontend logic, role switching, matching, booking, admin review, and analytics
- `index.html` — single-page UI
- `styles.css` — app styling
- `generate_docx.py` — export platform overview to Word
- `frep.db` — seeded SQLite database
- `integration_test.py` — backend API flow validation
- `check_api_endpoints.py` — quick endpoint health check

## Product requirements

See [PROJECT_REQUIREMENTS.md](PROJECT_REQUIREMENTS.md) for the supported roles, workflows, quality expectations, and the 25-hub industrial cluster directory.

## Requirements

- Python 3.14+ recommended
- Install dependencies:

```powershell
python -m pip install -r requirements.txt
```

## Run the app

```powershell
python server.py
```

Then open `http://127.0.0.1:8000` in your browser.

If port 8000 is already in use, start FREP on another port, for example:

```powershell
$env:FREP_PORT=8001
python server.py
```

Then open `http://127.0.0.1:8001`.

## Key workflows

- **Buyer:** browse and match resources, quick book, bundle cart, review bookings
- **Owner:** list new resources, update listing price and availability, remove listings
- **Admin:** review and approve or reject pending resource verification
- **Analytics:** dashboard metrics, demand vs supply charts, booking status
- **Notifications:** network alerts for bookings and verification actions

## Documentation export

Generate the Word summary document:

```powershell
python generate_docx.py
```

This creates `frep-explanation.docx`.

## Testing

Run the backend integration test:

```powershell
python integration_test.py
```

Check live API endpoints:

```powershell
python check_api_endpoints.py
```

## Notes

- The app uses a local SQLite database `frep.db`.
- The backend is meant for prototyping and should be replaced with production-ready deployment for a live system.
