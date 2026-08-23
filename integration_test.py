import json
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = 'http://127.0.0.1:8000'


def request(path, method='GET', body=None):
    url = BASE + path
    data = None
    headers = {'Content-Type': 'application/json'}
    if body is not None:
        data = json.dumps(body).encode('utf-8')
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=5) as resp:
            text = resp.read().decode('utf-8')
            return resp.status, json.loads(text)
    except HTTPError as he:
        body = he.read().decode('utf-8')
        return he.code, body
    except URLError as ue:
        return None, str(ue)


def main():
    tests = []
    tests.append(('health', '/api/health', 'GET'))
    tests.append(('dashboard', '/api/dashboard', 'GET'))
    tests.append(('resources', '/api/resources', 'GET'))
    tests.append(('bookings', '/api/bookings', 'GET'))
    tests.append(('notifications', '/api/notifications', 'GET'))
    tests.append(('analytics', '/api/analytics', 'GET'))

    for name, path, method in tests:
        status, data = request(path, method)
        print('GET', path, status, type(data).__name__)
        if isinstance(data, dict) and 'ok' in data:
            print('  ok payload', data)

    print('\nCreating a test resource...')
    status, data = request('/api/resources', 'POST', {
        'name': 'Test Press',
        'category': 'Machinery',
        'cluster': 'Test Cluster',
        'pricePerDay': 2500,
        'ownerId': 'O-999',
        'ownerName': 'Test Owner',
        'description': 'Test machine listing',
        'tags': ['test', 'press'],
    })
    print('POST /api/resources', status, data)
    new_id = data.get('id') if isinstance(data, dict) else None

    if new_id:
        print('Updating availability and verifying resource...')
        status, data = request(f'/api/resources/{new_id}', 'PATCH', {'availability': False, 'verified': True})
        print('PATCH /api/resources/<id>', status, data)

        print('Deleting test resource...')
        status, data = request(f'/api/resources/{new_id}', 'DELETE')
        print('DELETE /api/resources/<id>', status, data)

    print('\nCreating a booking for R-101...')
    status, data = request('/api/bookings', 'POST', {'resourceIds': ['R-101'], 'buyer': 'Integration Test Buyer'})
    print('POST /api/bookings', status, data)
    booking_id = data.get('id') if isinstance(data, dict) else None

    if booking_id:
        status, data = request(f'/api/bookings/{booking_id}', 'PATCH', {'action': 'complete'})
        print('PATCH complete booking', status, data)
        status, data = request(f'/api/bookings/{booking_id}', 'PATCH', {'action': 'rate', 'rating': 5})
        print('PATCH rate booking', status, data)

    print('\nDone.')


if __name__ == '__main__':
    main()
