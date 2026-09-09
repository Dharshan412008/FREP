import json
import os
from email.message import Message
from pathlib import Path
import runpy
import unittest
from unittest import mock
from urllib.parse import urlsplit

import check_api_endpoints as checker


PAYLOADS = {
    "/api/health": {"status": "ok"},
    "/api/dashboard": {},
    "/api/resources": [],
    "/api/bookings": [],
    "/api/notifications": [],
    "/api/analytics": {},
}


class FakeResponse:
    def __init__(
        self,
        payload=None,
        *,
        status=200,
        content_type="application/json",
        raw_body=None,
    ):
        self.status = status
        self.headers = Message()
        if content_type is not None:
            self.headers["Content-Type"] = content_type
        self._body = (
            raw_body
            if raw_body is not None
            else json.dumps(payload).encode("utf-8")
        )

    def read(self):
        return self._body

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False


class EndpointCheckerTests(unittest.TestCase):
    def test_all_endpoints_pass_and_requests_have_expected_contract(self):
        calls = []

        def opener(request, *, timeout):
            path = urlsplit(request.full_url).path
            calls.append((request.full_url, request.get_header("Accept"), timeout))
            return FakeResponse(
                PAYLOADS[path],
                content_type="Application/JSON; charset=utf-8",
            )

        output = []
        with mock.patch.dict(
            os.environ,
            {"FREP_BASE_URL": "https://frep.example///"},
            clear=False,
        ):
            exit_code = checker.run_checks(
                opener=opener,
                timeout=1.25,
                output=output.append,
            )

        expected_urls = [
            f"https://frep.example{path}" for path, _ in checker.ENDPOINTS
        ]
        self.assertEqual(exit_code, 0)
        self.assertEqual([call[0] for call in calls], expected_urls)
        self.assertTrue(all(call[1] == "application/json" for call in calls))
        self.assertTrue(all(call[2] == 1.25 for call in calls))
        self.assertEqual(sum(line.startswith("[PASS]") for line in output), 6)
        self.assertEqual(output[-1], "Summary: 6 passed, 0 failed")

    def test_failure_does_not_stop_later_checks_and_returns_nonzero(self):
        requested_paths = []

        def opener(request, *, timeout):
            path = urlsplit(request.full_url).path
            requested_paths.append(path)
            if path == "/api/dashboard":
                raise TimeoutError("simulated timeout")
            return FakeResponse(PAYLOADS[path])

        output = []
        exit_code = checker.run_checks(
            base_url="https://frep.example",
            opener=opener,
            output=output.append,
        )

        self.assertEqual(exit_code, 1)
        self.assertEqual(
            requested_paths,
            [path for path, _ in checker.ENDPOINTS],
        )
        self.assertTrue(
            any(
                line.startswith("[FAIL] GET /api/dashboard")
                and "TimeoutError" in line
                for line in output
            )
        )
        self.assertTrue(any(line.startswith("[PASS] GET /api/analytics") for line in output))
        self.assertEqual(output[-1], "Summary: 5 passed, 1 failed")

    def test_invalid_response_contracts_fail_with_a_useful_reason(self):
        cases = (
            (
                "http status",
                "/api/health",
                dict,
                FakeResponse({"status": "ok"}, status=503),
                "expected HTTP 200, received HTTP 503",
            ),
            (
                "content type",
                "/api/dashboard",
                dict,
                FakeResponse({}, content_type="text/plain; charset=utf-8"),
                "expected a JSON Content-Type",
            ),
            (
                "invalid json",
                "/api/dashboard",
                dict,
                FakeResponse(raw_body=b"{not-json"),
                "JSONDecodeError",
            ),
            (
                "top-level shape",
                "/api/resources",
                list,
                FakeResponse({}),
                "expected a JSON list, received dict",
            ),
            (
                "health state",
                "/api/health",
                dict,
                FakeResponse({"status": "degraded"}),
                "health payload did not report status=ok",
            ),
        )

        for name, path, expected_type, response, expected_detail in cases:
            with self.subTest(name=name):
                passed, detail = checker.check_endpoint(
                    "https://frep.example",
                    path,
                    expected_type,
                    opener=lambda request, timeout, result=response: result,
                )
                self.assertFalse(passed)
                self.assertIn(expected_detail, detail)

    def test_importing_script_does_not_run_network_checks(self):
        script_path = Path(checker.__file__)
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=AssertionError("network access during import"),
        ) as mocked_urlopen:
            namespace = runpy.run_path(
                str(script_path),
                run_name="check_api_endpoints_import_test",
            )

        mocked_urlopen.assert_not_called()
        self.assertIn("main", namespace)
        self.assertEqual(namespace["ENDPOINTS"], checker.ENDPOINTS)


if __name__ == "__main__":
    unittest.main()
