import requests
payload = {
    'productName': 'Aluminium Bracket',
    'quantity': 2000,
    'material': 'Aluminium',
    'processes': 'CNC machining, Surface finishing, Quality inspection, Logistics',
    'deadline': 5,
    'budget': 100000,
    'cluster': 'Coimbatore',
    'quality': 'High',
    'transport': 'Standard'
}
try:
    r = requests.post('http://127.0.0.1:8000/api/production/plan', json=payload, timeout=10)
    print('STATUS', r.status_code)
    print(r.text)
except Exception as e:
    print('ERROR', e)
