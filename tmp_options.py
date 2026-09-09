import requests
try:
    r = requests.options('http://127.0.0.1:8000/api/production/plan', timeout=10)
    print('STATUS', r.status_code)
    print('HEADERS:', dict(r.headers))
    print('TEXT:', r.text)
except Exception as e:
    print('ERROR', e)
