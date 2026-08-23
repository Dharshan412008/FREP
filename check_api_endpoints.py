import json
from urllib.request import urlopen, Request

urls = [
    'http://127.0.0.1:8000/api/health',
    'http://127.0.0.1:8000/api/dashboard',
    'http://127.0.0.1:8000/api/resources',
    'http://127.0.0.1:8000/api/bookings',
    'http://127.0.0.1:8000/api/notifications',
    'http://127.0.0.1:8000/api/analytics',
]

for url in urls:
    req = Request(url, headers={'Accept': 'application/json'})
    try:
        with urlopen(req, timeout=5) as resp:
            body = resp.read().decode('utf-8')
            status = resp.status
            data = json.loads(body)
            print(url, status, json.dumps(data, indent=2)[:360])
    except Exception as exc:
        print(url, 'ERROR', exc)
