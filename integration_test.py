"""Strict authenticated live workflow check for the FREP API."""

import json
import os
import sys
from http.cookiejar import CookieJar
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen


BASE = os.environ.get("FREP_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
PUBLIC_READS = (
    ("/api/health", dict),
    ("/api/dashboard", dict),
    ("/api/resources", list),
    ("/api/bookings", list),
    ("/api/notifications", list),
    ("/api/analytics", dict),
)


class IntegrationCheckError(RuntimeError):
    """Raised when a live response does not satisfy the expected contract."""


def _decode_json(raw):
    text = raw.decode("utf-8")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _content_type(headers):
    value = headers.get("Content-Type", "") if headers is not None else ""
    return value.split(";", 1)[0].strip().lower()


def _decode_response(response):
    media_type = _content_type(getattr(response, "headers", None))
    if media_type != "application/json" and not media_type.endswith("+json"):
        shown_type = media_type or "missing Content-Type"
        return f"expected a JSON Content-Type, received {shown_type}"
    return _decode_json(response.read())


def request(path, method="GET", body=None, opener=None):
    url = BASE + path
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, data=data, headers=headers, method=method)
    try:
        open_request = opener.open if opener is not None else urlopen
        with open_request(req, timeout=5) as response:
            return response.status, _decode_response(response)
    except HTTPError as error:
        return error.code, _decode_json(error.read())
    except (URLError, TimeoutError, OSError) as error:
        return None, str(error)


def require_response(label, status, payload, expected_type, *, require_ok=False):
    """Validate and print one integration response, or stop the live gate."""

    print(label, status, type(payload).__name__)
    if status != 200:
        raise IntegrationCheckError(
            f"{label} expected HTTP 200, received {status}: {payload}"
        )
    if not isinstance(payload, expected_type):
        raise IntegrationCheckError(
            f"{label} expected {expected_type.__name__}, "
            f"received {type(payload).__name__}: {payload}"
        )
    if require_ok and payload.get("ok") is not True:
        raise IntegrationCheckError(f"{label} did not return ok=true: {payload}")
    return payload


def require_record(
    path, record_id, expected_values=None, *, present=True, opener=None
):
    """Read back a list endpoint and validate one record's persisted state."""

    status, payload = (
        request(path, opener=opener) if opener is not None else request(path)
    )
    payload = require_response(f"VERIFY GET {path}", status, payload, list)
    record = next(
        (
            item
            for item in payload
            if isinstance(item, dict) and item.get("id") == record_id
        ),
        None,
    )
    if not present:
        if record is not None:
            raise IntegrationCheckError(
                f"VERIFY GET {path} still contains deleted record {record_id}: {record}"
            )
        return None
    if record is None:
        raise IntegrationCheckError(
            f"VERIFY GET {path} did not contain expected record {record_id}"
        )
    for key, expected in (expected_values or {}).items():
        if record.get(key) != expected:
            raise IntegrationCheckError(
                f"VERIFY GET {path} expected {record_id}.{key}={expected!r}, "
                f"received {record.get(key)!r}: {record}"
            )
    return record


def authenticated_client(username, password, expected_role):
    """Return an opener that keeps FREP's signed session cookie."""

    opener = build_opener(HTTPCookieProcessor(CookieJar()))
    status, payload = request(
        "/api/auth/login",
        "POST",
        {"username": username, "password": password},
        opener,
    )
    payload = require_response(
        f"POST /api/auth/login ({username})",
        status,
        payload,
        dict,
        require_ok=True,
    )
    user = payload.get("user")
    if (
        not isinstance(user, dict)
        or user.get("username") != username
        or user.get("role") != expected_role
    ):
        raise IntegrationCheckError(
            f"Login for {username!r} did not return the expected identity/role: {payload}"
        )
    return opener


def run_integration():
    print("Logging in as the three demo roles...")
    buyer_client = authenticated_client("buyer", "buyer123", "buyer")
    owner_client = authenticated_client("owner", "owner123", "owner")
    admin_client = authenticated_client("admin", "admin123", "admin")

    print("\nChecking public read contracts...")
    for path, expected_type in PUBLIC_READS:
        status, payload = request(path)
        payload = require_response(f"GET {path}", status, payload, expected_type)
        if path == "/api/health" and payload.get("status") != "ok":
            raise IntegrationCheckError(
                f"GET /api/health did not report status=ok: {payload}"
            )

    resource_id = None
    resource_deleted = False
    booking_id = None
    booking_completed = False
    booking_may_be_active = False
    try:
        print("\nCreating a test resource...")
        status, payload = request(
            "/api/resources",
            "POST",
            {
                "name": "Test Press",
                "category": "Machinery",
                "cluster": "Test Cluster",
                "pricePerDay": 2500,
                "description": "Test machine listing",
                "tags": ["test", "press"],
            },
            owner_client,
        )
        payload = require_response(
            "POST /api/resources", status, payload, dict, require_ok=True
        )
        resource_id = payload.get("id")
        if not isinstance(resource_id, str) or not resource_id:
            raise IntegrationCheckError(
                f"POST /api/resources did not return a resource id: {payload}"
            )

        status, payload = request(
            f"/api/resources/{resource_id}",
            "PATCH",
            {"availability": False, "pricePerDay": 2600},
            owner_client,
        )
        require_response(
            "PATCH owner fields /api/resources/<id>",
            status,
            payload,
            dict,
            require_ok=True,
        )
        require_record(
            "/api/resources",
            resource_id,
            {"pricePerDay": 2600, "availability": False, "verified": False},
        )

        status, payload = request(
            f"/api/resources/{resource_id}",
            "PATCH",
            {"verified": True},
            admin_client,
        )
        require_response(
            "PATCH verification /api/resources/<id>",
            status,
            payload,
            dict,
            require_ok=True,
        )
        require_record(
            "/api/resources",
            resource_id,
            {"pricePerDay": 2600, "availability": False, "verified": True},
        )

        status, payload = request(
            f"/api/resources/{resource_id}",
            "PATCH",
            {"availability": True},
            owner_client,
        )
        require_response(
            "PATCH booking availability /api/resources/<id>",
            status,
            payload,
            dict,
            require_ok=True,
        )
        require_record(
            "/api/resources",
            resource_id,
            {"pricePerDay": 2600, "availability": True, "verified": True},
        )

        print("\nCreating a booking for the integration resource...")
        status, payload = request(
            "/api/bookings",
            "POST",
            {"resourceIds": [resource_id], "buyer": "Ignored Spoofed Buyer"},
            buyer_client,
        )
        booking_may_be_active = status == 200
        payload = require_response(
            "POST /api/bookings", status, payload, dict, require_ok=True
        )
        booking_id = payload.get("id")
        if not isinstance(booking_id, str) or not booking_id:
            raise IntegrationCheckError(
                f"POST /api/bookings did not return a booking id: {payload}"
            )
        require_record(
            "/api/bookings",
            booking_id,
            {
                "buyer": "Demo Buyer",
                "status": "In Progress",
                "resources": [resource_id],
                "rating": None,
            },
            opener=buyer_client,
        )
        require_record(
            "/api/resources", resource_id, {"availability": False}
        )

        status, payload = request(
            f"/api/bookings/{booking_id}",
            "PATCH",
            {"action": "complete"},
            buyer_client,
        )
        require_response(
            "PATCH complete booking", status, payload, dict, require_ok=True
        )
        require_record(
            "/api/bookings",
            booking_id,
            {"status": "Completed"},
            opener=buyer_client,
        )
        booking_completed = True
        booking_may_be_active = False
        require_record(
            "/api/resources", resource_id, {"availability": True}
        )

        status, payload = request(
            f"/api/bookings/{booking_id}",
            "PATCH",
            {"action": "rate", "rating": 5},
            buyer_client,
        )
        require_response(
            "PATCH rate booking", status, payload, dict, require_ok=True
        )
        require_record(
            "/api/bookings",
            booking_id,
            {"status": "Completed", "rating": 5},
            opener=buyer_client,
        )

        status, payload = request(
            f"/api/resources/{resource_id}", "DELETE", opener=owner_client
        )
        require_response(
            "DELETE /api/resources/<id>",
            status,
            payload,
            dict,
            require_ok=True,
        )
        resource_deleted = True
        require_record("/api/resources", resource_id, present=False)
    finally:
        if booking_id and not booking_completed:
            cleanup_status, cleanup_payload = request(
                f"/api/bookings/{booking_id}",
                "PATCH",
                {"action": "complete"},
                buyer_client,
            )
            print(
                "CLEANUP PATCH complete booking",
                cleanup_status,
                type(cleanup_payload).__name__,
            )
            cleanup_confirmed = (
                cleanup_status == 200
                and isinstance(cleanup_payload, dict)
                and cleanup_payload.get("ok") is True
            )
            if cleanup_confirmed:
                try:
                    require_record(
                        "/api/bookings",
                        booking_id,
                        {"status": "Completed"},
                        opener=buyer_client,
                    )
                except IntegrationCheckError as cleanup_error:
                    cleanup_confirmed = False
                    print(f"CLEANUP VERIFY booking completion failed: {cleanup_error}")
                else:
                    booking_completed = True
                    booking_may_be_active = False
        if resource_id and not resource_deleted:
            if booking_may_be_active:
                print(
                    "CLEANUP SKIPPED DELETE /api/resources/<id>: "
                    "booking completion was not confirmed"
                )
            else:
                cleanup_status, cleanup_payload = request(
                    f"/api/resources/{resource_id}", "DELETE", opener=owner_client
                )
                print(
                    "CLEANUP DELETE /api/resources/<id>",
                    cleanup_status,
                    type(cleanup_payload).__name__,
                )


def main():
    try:
        run_integration()
    except IntegrationCheckError as error:
        sys.stdout.flush()
        print(f"\nIntegration check FAILED: {error}", file=sys.stderr)
        return 1
    print("\nIntegration check PASSED.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
