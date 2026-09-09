"""Strict live health and response-contract checks for FREP's public API."""

import json
import os
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_TIMEOUT_SECONDS = 5
ENDPOINTS = (
    ("/api/health", dict),
    ("/api/dashboard", dict),
    ("/api/resources", list),
    ("/api/bookings", list),
    ("/api/notifications", list),
    ("/api/analytics", dict),
)


def _content_type(headers):
    value = headers.get("Content-Type", "") if headers is not None else ""
    return value.split(";", 1)[0].strip().lower()


def _is_json_content_type(media_type):
    return media_type == "application/json" or media_type.endswith("+json")


def _payload_summary(payload):
    if isinstance(payload, list):
        return f"JSON array with {len(payload)} item(s)"
    return f"JSON object with {len(payload)} key(s)"


def check_endpoint(base_url, path, expected_type, *, opener=None, timeout=DEFAULT_TIMEOUT_SECONDS):
    """Return ``(passed, detail)`` for one public endpoint contract."""

    open_request = opener or urlopen
    request = Request(f"{base_url}{path}", headers={"Accept": "application/json"})
    try:
        with open_request(request, timeout=timeout) as response:
            status = getattr(response, "status", None)
            if status is None:
                status = response.getcode()
            if status != 200:
                return False, f"expected HTTP 200, received HTTP {status}"

            media_type = _content_type(getattr(response, "headers", None))
            if not _is_json_content_type(media_type):
                shown_type = media_type or "missing Content-Type"
                return False, f"expected a JSON Content-Type, received {shown_type}"

            charset = "utf-8"
            headers = getattr(response, "headers", None)
            if headers is not None and hasattr(headers, "get_content_charset"):
                charset = headers.get_content_charset() or charset
            payload = json.loads(response.read().decode(charset))
            if not isinstance(payload, expected_type):
                return False, (
                    f"expected a JSON {expected_type.__name__}, "
                    f"received {type(payload).__name__}"
                )
            if path == "/api/health" and payload.get("status") != "ok":
                return False, "health payload did not report status=ok"
            return True, f"HTTP 200; {_payload_summary(payload)}"
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


def run_checks(*, base_url=None, opener=None, timeout=DEFAULT_TIMEOUT_SECONDS, output=print):
    """Run every public check and return a process-style exit code."""

    configured_base = base_url
    if configured_base is None:
        configured_base = os.environ.get("FREP_BASE_URL") or DEFAULT_BASE_URL
    configured_base = configured_base.strip().rstrip("/")
    if not configured_base:
        output("FREP API check configuration error: base URL is empty.")
        return 2

    output(f"FREP public API check: {configured_base}")
    passed = 0
    for path, expected_type in ENDPOINTS:
        ok, detail = check_endpoint(
            configured_base,
            path,
            expected_type,
            opener=opener,
            timeout=timeout,
        )
        output(f"[{'PASS' if ok else 'FAIL'}] GET {path} - {detail}")
        passed += int(ok)

    failed = len(ENDPOINTS) - passed
    output(f"Summary: {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


def main():
    return run_checks()


if __name__ == "__main__":
    raise SystemExit(main())
