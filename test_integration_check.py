import contextlib
import io
from pathlib import Path
import runpy
import unittest
from unittest import mock

import integration_test as integration


def login_payload(username, role):
    return {
        "ok": True,
        "user": {
            "username": username,
            "role": role,
        },
    }


class IntegrationCheckTests(unittest.TestCase):
    def run_main_silently(self):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exit_code = integration.main()
        return exit_code, stdout.getvalue(), stderr.getvalue()

    def test_full_mocked_workflow_succeeds_in_exact_dependent_order(self):
        buyer_client = object()
        owner_client = object()
        admin_client = object()
        responses = [
            (200, login_payload("buyer", "buyer")),
            (200, login_payload("owner", "owner")),
            (200, login_payload("admin", "admin")),
            (200, {"status": "ok"}),
            (200, {}),
            (200, []),
            (200, []),
            (200, []),
            (200, {}),
            (200, {"ok": True, "id": "R-INTEGRATION"}),
            (200, {"ok": True}),
            (200, [{"id": "R-INTEGRATION", "pricePerDay": 2600, "availability": False, "verified": False}]),
            (200, {"ok": True}),
            (200, [{"id": "R-INTEGRATION", "pricePerDay": 2600, "availability": False, "verified": True}]),
            (200, {"ok": True}),
            (200, [{"id": "R-INTEGRATION", "pricePerDay": 2600, "availability": True, "verified": True}]),
            (200, {"ok": True, "id": "B-INTEGRATION"}),
            (200, [{"id": "B-INTEGRATION", "buyer": "Demo Buyer", "status": "In Progress", "resources": ["R-INTEGRATION"], "rating": None}]),
            (200, [{"id": "R-INTEGRATION", "availability": False}]),
            (200, {"ok": True}),
            (200, [{"id": "B-INTEGRATION", "status": "Completed"}]),
            (200, [{"id": "R-INTEGRATION", "availability": True}]),
            (200, {"ok": True}),
            (200, [{"id": "B-INTEGRATION", "status": "Completed", "rating": 5}]),
            (200, {"ok": True}),
            (200, []),
        ]

        with mock.patch.object(
            integration,
            "build_opener",
            side_effect=[buyer_client, owner_client, admin_client],
        ) as mocked_build_opener, mock.patch.object(
            integration, "request", side_effect=responses
        ) as mocked_request:
            exit_code, stdout, stderr = self.run_main_silently()

        self.assertEqual(exit_code, 0)
        self.assertIn("Integration check PASSED.", stdout)
        self.assertEqual(stderr, "")
        self.assertEqual(mocked_build_opener.call_count, 3)
        self.assertEqual(
            mocked_request.call_args_list,
            [
                mock.call(
                    "/api/auth/login",
                    "POST",
                    {"username": "buyer", "password": "buyer123"},
                    buyer_client,
                ),
                mock.call(
                    "/api/auth/login",
                    "POST",
                    {"username": "owner", "password": "owner123"},
                    owner_client,
                ),
                mock.call(
                    "/api/auth/login",
                    "POST",
                    {"username": "admin", "password": "admin123"},
                    admin_client,
                ),
                mock.call("/api/health"),
                mock.call("/api/dashboard"),
                mock.call("/api/resources"),
                mock.call("/api/bookings"),
                mock.call("/api/notifications"),
                mock.call("/api/analytics"),
                mock.call(
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
                ),
                mock.call(
                    "/api/resources/R-INTEGRATION",
                    "PATCH",
                    {"availability": False, "pricePerDay": 2600},
                    owner_client,
                ),
                mock.call("/api/resources"),
                mock.call(
                    "/api/resources/R-INTEGRATION",
                    "PATCH",
                    {"verified": True},
                    admin_client,
                ),
                mock.call("/api/resources"),
                mock.call(
                    "/api/resources/R-INTEGRATION",
                    "PATCH",
                    {"availability": True},
                    owner_client,
                ),
                mock.call("/api/resources"),
                mock.call(
                    "/api/bookings",
                    "POST",
                    {
                        "resourceIds": ["R-INTEGRATION"],
                        "buyer": "Ignored Spoofed Buyer",
                    },
                    buyer_client,
                ),
                mock.call("/api/bookings", opener=buyer_client),
                mock.call("/api/resources"),
                mock.call(
                    "/api/bookings/B-INTEGRATION",
                    "PATCH",
                    {"action": "complete"},
                    buyer_client,
                ),
                mock.call("/api/bookings", opener=buyer_client),
                mock.call("/api/resources"),
                mock.call(
                    "/api/bookings/B-INTEGRATION",
                    "PATCH",
                    {"action": "rate", "rating": 5},
                    buyer_client,
                ),
                mock.call("/api/bookings", opener=buyer_client),
                mock.call(
                    "/api/resources/R-INTEGRATION",
                    "DELETE",
                    opener=owner_client,
                ),
                mock.call("/api/resources"),
            ],
        )

    def test_operation_failure_returns_one_and_still_cleans_up_listing(self):
        buyer_client = object()
        owner_client = object()
        admin_client = object()
        responses = [
            (200, {"ok": True, "id": "R-CLEANUP"}),
            (503, {"ok": False, "error": "update unavailable"}),
            (200, {"ok": True}),
        ]

        with mock.patch.object(
            integration,
            "authenticated_client",
            side_effect=[buyer_client, owner_client, admin_client],
        ) as mocked_auth, mock.patch.object(
            integration, "PUBLIC_READS", ()
        ), mock.patch.object(
            integration, "request", side_effect=responses
        ) as mocked_request:
            exit_code, stdout, stderr = self.run_main_silently()

        self.assertEqual(exit_code, 1)
        self.assertIn("Integration check FAILED:", stderr)
        self.assertIn("expected HTTP 200, received 503", stderr)
        self.assertIn("CLEANUP DELETE /api/resources/<id> 200 dict", stdout)
        self.assertEqual(
            mocked_auth.call_args_list,
            [
                mock.call("buyer", "buyer123", "buyer"),
                mock.call("owner", "owner123", "owner"),
                mock.call("admin", "admin123", "admin"),
            ],
        )
        self.assertEqual(
            mocked_request.call_args_list,
            [
                mock.call(
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
                ),
                mock.call(
                    "/api/resources/R-CLEANUP",
                    "PATCH",
                    {"availability": False, "pricePerDay": 2600},
                    owner_client,
                ),
                mock.call(
                    "/api/resources/R-CLEANUP",
                    "DELETE",
                    opener=owner_client,
                ),
            ],
        )

    def test_post_booking_failure_best_effort_completes_then_deletes(self):
        buyer_client = object()
        owner_client = object()
        admin_client = object()
        responses = [
            (200, {"ok": True, "id": "R-BOOKED"}),
            (200, {"ok": True}),
            (200, [{"id": "R-BOOKED", "pricePerDay": 2600, "availability": False, "verified": False}]),
            (200, {"ok": True}),
            (200, [{"id": "R-BOOKED", "pricePerDay": 2600, "availability": False, "verified": True}]),
            (200, {"ok": True}),
            (200, [{"id": "R-BOOKED", "pricePerDay": 2600, "availability": True, "verified": True}]),
            (200, {"ok": True, "id": "B-CLEANUP"}),
            (200, [{"id": "B-CLEANUP", "buyer": "Demo Buyer", "status": "In Progress", "resources": ["R-BOOKED"], "rating": None}]),
            (200, [{"id": "R-BOOKED", "availability": False}]),
            (500, {"ok": False, "error": "completion failed"}),
            (200, {"ok": True}),
            (200, [{"id": "B-CLEANUP", "status": "Completed"}]),
            (200, {"ok": True}),
        ]

        with mock.patch.object(
            integration,
            "authenticated_client",
            side_effect=[buyer_client, owner_client, admin_client],
        ), mock.patch.object(
            integration, "PUBLIC_READS", ()
        ), mock.patch.object(
            integration, "request", side_effect=responses
        ) as mocked_request:
            exit_code, stdout, stderr = self.run_main_silently()

        self.assertEqual(exit_code, 1)
        self.assertIn("Integration check FAILED:", stderr)
        self.assertIn("PATCH complete booking expected HTTP 200", stderr)
        self.assertIn("CLEANUP PATCH complete booking 200 dict", stdout)
        self.assertIn("CLEANUP DELETE /api/resources/<id> 200 dict", stdout)
        self.assertEqual(
            mocked_request.call_args_list[-3:],
            [
                mock.call(
                    "/api/bookings/B-CLEANUP",
                    "PATCH",
                    {"action": "complete"},
                    buyer_client,
                ),
                mock.call("/api/bookings", opener=buyer_client),
                mock.call(
                    "/api/resources/R-BOOKED",
                    "DELETE",
                    opener=owner_client,
                ),
            ],
        )

    def test_importing_script_does_not_run_the_workflow(self):
        script_path = Path(integration.__file__)
        with mock.patch(
            "urllib.request.urlopen",
            side_effect=AssertionError("network access during import"),
        ) as mocked_urlopen:
            namespace = runpy.run_path(
                str(script_path),
                run_name="integration_check_import_test",
            )

        mocked_urlopen.assert_not_called()
        self.assertIn("main", namespace)
        self.assertIn("run_integration", namespace)


if __name__ == "__main__":
    unittest.main()
