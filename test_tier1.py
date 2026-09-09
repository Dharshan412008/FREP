"""Tier 1 regression tests for FREP.

The suite deliberately imports ``server.py`` only after pointing FREP at a
temporary database containing the pre-Tier-1 schema.  It therefore exercises
the additive migration without reading from or writing to the checked-in
``frep.db``.
"""

import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

from werkzeug.security import check_password_hash


ROOT = Path(__file__).resolve().parent
_TEMP_DIRECTORY = tempfile.TemporaryDirectory(prefix="frep-tier1-")
TEST_DB_PATH = Path(_TEMP_DIRECTORY.name) / "legacy-frep.db"
_ENVIRONMENT_BEFORE_TESTS = {
    name: os.environ.get(name)
    for name in ("FREP_DB_PATH", "FREP_SECRET_KEY", "GROQ_API_KEY", "GEMINI_API_KEY")
}


def create_legacy_database(path):
    """Create the database shape shipped before Tier 1 authentication."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE resources (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            cluster TEXT NOT NULL,
            price_per_day INTEGER NOT NULL,
            verified INTEGER NOT NULL DEFAULT 0,
            rating REAL NOT NULL DEFAULT 4.0,
            availability INTEGER NOT NULL DEFAULT 1,
            owner_id TEXT NOT NULL,
            owner_name TEXT NOT NULL,
            description TEXT NOT NULL,
            tags TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE bookings (
            id TEXT PRIMARY KEY,
            buyer TEXT NOT NULL,
            status TEXT NOT NULL,
            total INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            rating INTEGER,
            resources_json TEXT NOT NULL,
            note TEXT
        );

        CREATE TABLE notifications (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            detail TEXT NOT NULL,
            kind TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE production_requests (
            id TEXT PRIMARY KEY,
            product_name TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            material TEXT NOT NULL,
            processes TEXT NOT NULL,
            deadline_days INTEGER NOT NULL,
            budget INTEGER NOT NULL,
            cluster TEXT NOT NULL,
            quality TEXT,
            transport_requirement TEXT,
            created_at TEXT NOT NULL,
            analyzed_capabilities TEXT NOT NULL,
            recommended_bundle TEXT NOT NULL
        );

        CREATE TABLE industrial_clusters (
            name TEXT PRIMARY KEY,
            city TEXT NOT NULL,
            state TEXT NOT NULL,
            region TEXT NOT NULL
        );
        """
    )
    conn.execute(
        """
        INSERT INTO resources
        (id, name, category, cluster, price_per_day, verified, rating,
         availability, owner_id, owner_name, description, tags, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "R-LEGACY",
            "Legacy CNC Mill",
            "Machinery",
            "Peenya",
            2800,
            1,
            4.7,
            1,
            "O-OTHER",
            "Legacy Works",
            "CNC machining for precision steel components.",
            json.dumps(["cnc", "precision", "steel"]),
            "2026-01-01",
        ),
    )
    conn.execute(
        """
        INSERT INTO bookings
        (id, buyer, status, total, created_at, rating, resources_json, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "B-LEGACY",
            "Legacy Buyer",
            "Completed",
            2800,
            "2026-01-02",
            5,
            json.dumps(["R-LEGACY"]),
            "Must survive the Tier 1 migration",
        ),
    )
    conn.execute(
        """
        INSERT INTO notifications (id, title, detail, kind, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        ("N-LEGACY", "Legacy notice", "Migration fixture", "insight", "2026-01-03"),
    )
    conn.execute(
        """
        INSERT INTO production_requests
        (id, product_name, quantity, material, processes, deadline_days,
         budget, cluster, quality, transport_requirement, created_at,
         analyzed_capabilities, recommended_bundle)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "PR-LEGACY",
            "Legacy Part",
            10,
            "Steel",
            "CNC machining",
            7,
            10000,
            "Peenya",
            "Standard",
            "Standard",
            "2026-01-04",
            json.dumps(["CNC Machining"]),
            json.dumps({"feasible": True}),
        ),
    )
    conn.execute(
        """
        INSERT INTO industrial_clusters (name, city, state, region)
        VALUES (?, ?, ?, ?)
        """,
        ("Legacy Hub", "Legacy City", "Karnataka", "South"),
    )
    conn.commit()
    conn.close()


create_legacy_database(TEST_DB_PATH)
os.environ["FREP_DB_PATH"] = str(TEST_DB_PATH)
os.environ["FREP_SECRET_KEY"] = "tier1-test-only-signed-session-secret"
os.environ.pop("GROQ_API_KEY", None)
os.environ.pop("GEMINI_API_KEY", None)

# A unique module name avoids accidentally reusing a production-DB-bound
# ``server`` module when this file is invoked from a larger unittest run.
_SERVER_SPEC = importlib.util.spec_from_file_location(
    "frep_server_tier1_tests", ROOT / "server.py"
)
server = importlib.util.module_from_spec(_SERVER_SPEC)
_SERVER_SPEC.loader.exec_module(server)
server.app.config.update(TESTING=True)


def tearDownModule():
    for name, value in _ENVIRONMENT_BEFORE_TESTS.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    _TEMP_DIRECTORY.cleanup()


class Tier1TestCase(unittest.TestCase):
    credentials = {
        "buyer": "buyer123",
        "owner": "owner123",
        "admin": "admin123",
    }

    def client_for(self, role):
        client = server.app.test_client()
        response = client.post(
            "/api/auth/login",
            json={"username": role, "password": self.credentials[role]},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.get_json()["ok"])
        return client

    def assert_api_error(self, response, status):
        self.assertEqual(response.status_code, status, response.get_data(as_text=True))
        body = response.get_json()
        self.assertIsInstance(body, dict)
        self.assertFalse(body.get("ok", True))
        self.assertIsInstance(body.get("error"), dict)

    def resource_by_id(self, resource_id):
        response = server.app.test_client().get("/api/resources")
        self.assertEqual(response.status_code, 200)
        return next(
            (item for item in response.get_json() if item["id"] == resource_id),
            None,
        )

    def production_request_count(self):
        conn = sqlite3.connect(TEST_DB_PATH)
        try:
            return conn.execute("SELECT COUNT(*) FROM production_requests").fetchone()[0]
        finally:
            conn.close()

    def table_count(self, table):
        """Count one of the fixed test tables without accepting SQL input."""
        allowed = {
            "resources",
            "bookings",
            "notifications",
            "production_requests",
            "copilot_confirmations",
            "audit_logs",
        }
        self.assertIn(table, allowed)
        conn = sqlite3.connect(TEST_DB_PATH)
        try:
            return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        finally:
            conn.close()

    def insert_bookable_resource(
        self,
        *,
        name="Tier 2 CNC Cell",
        cluster="Peenya",
        price_per_day=2400,
    ):
        resource_id = f"R-TIER2-{uuid.uuid4().hex[:10].upper()}"
        conn = sqlite3.connect(TEST_DB_PATH)
        try:
            conn.execute(
                """
                INSERT INTO resources
                (id, name, category, cluster, price_per_day, verified, rating,
                 availability, owner_id, owner_name, description, tags,
                 capabilities, created_at)
                VALUES (?, ?, ?, ?, ?, 1, 4.8, 1, ?, ?, ?, ?, ?, ?)
                """,
                (
                    resource_id,
                    name,
                    "Machinery",
                    cluster,
                    price_per_day,
                    "O-TIER2-FIXTURE",
                    "Tier 2 Fixture Works",
                    "Verified CNC machining capacity for regression tests.",
                    json.dumps(["cnc", "machining", "fixture"]),
                    json.dumps(["CNC Machining"]),
                    "2026-08-27",
                ),
            )
            conn.commit()
        finally:
            conn.close()
        return resource_id

    def delete_test_resource(self, resource_id):
        conn = sqlite3.connect(TEST_DB_PATH)
        try:
            conn.execute("DELETE FROM resources WHERE id = ?", (resource_id,))
            conn.commit()
        finally:
            conn.close()

    def assert_explanation(self, container):
        for key in ("why", "weights", "contributions", "drivers"):
            self.assertIn(key, container)
        self.assertIsInstance(container["why"], str)
        self.assertTrue(container["why"].strip())
        self.assertNotIn("\n", container["why"])
        self.assertIsInstance(container["weights"], dict)
        self.assertIsInstance(container["contributions"], dict)
        self.assertTrue(container["weights"])
        self.assertEqual(set(container["weights"]), set(container["contributions"]))
        for value in container["weights"].values():
            self.assertIsInstance(value, (int, float))
            self.assertGreaterEqual(value, 0)
            self.assertLessEqual(value, 100)
        for displayed in re.findall(r"\(([0-9]+(?:\.[0-9]+)?)%\)", container["why"]):
            self.assertTrue(
                any(abs(float(displayed) - float(weight)) < 0.02 for weight in container["weights"].values()),
                f"Displayed weight {displayed}% is absent from {container['weights']}",
            )
        for value in container["contributions"].values():
            self.assertIsInstance(value, (int, float))
            self.assertGreaterEqual(value, 0)
        self.assertIsInstance(container["drivers"], list)
        self.assertGreater(len(container["drivers"]), 0)
        self.assertLessEqual(len(container["drivers"]), 3)
        for driver in container["drivers"]:
            self.assertTrue(
                {"factor", "label", "score", "weight", "contribution"}.issubset(driver)
            )


class AdditiveMigrationTests(Tier1TestCase):
    def test_legacy_data_survives_and_users_are_added_with_hashes(self):
        conn = sqlite3.connect(TEST_DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            tables = {
                row["name"]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }
            self.assertTrue(
                {
                    "resources",
                    "bookings",
                    "notifications",
                    "production_requests",
                    "industrial_clusters",
                    "users",
                }.issubset(tables)
            )
            self.assertEqual(
                conn.execute("SELECT name FROM resources WHERE id = 'R-LEGACY'").fetchone()[0],
                "Legacy CNC Mill",
            )
            self.assertEqual(
                conn.execute("SELECT buyer FROM bookings WHERE id = 'B-LEGACY'").fetchone()[0],
                "Legacy Buyer",
            )
            self.assertEqual(
                conn.execute(
                    "SELECT product_name FROM production_requests WHERE id = 'PR-LEGACY'"
                ).fetchone()[0],
                "Legacy Part",
            )

            user_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(users)")
            }
            self.assertTrue(
                {
                    "id",
                    "username",
                    "display_name",
                    "role",
                    "owner_id",
                    "password_hash",
                }.issubset(user_columns)
            )
            self.assertNotIn("password", user_columns)
            users = {
                row["username"]: row
                for row in conn.execute(
                    "SELECT id, username, role, owner_id, password_hash FROM users"
                )
            }
            self.assertTrue({"buyer", "owner", "admin"}.issubset(users))
            self.assertEqual(users["buyer"]["id"], "U-BUYER")
            self.assertEqual(users["owner"]["id"], "U-OWNER")
            self.assertEqual(users["admin"]["id"], "U-ADMIN")
            self.assertEqual(users["owner"]["owner_id"], "O-100")
            for username, password in self.credentials.items():
                stored = users[username]["password_hash"]
                self.assertNotEqual(stored, password)
                self.assertNotIn(password, stored)
                self.assertTrue(check_password_hash(stored, password))
        finally:
            conn.close()

    def test_static_file_routes_do_not_expose_source_or_database(self):
        client = server.app.test_client()
        self.assertEqual(client.get("/frep.db").status_code, 404)
        self.assertEqual(client.get("/server.py").status_code, 404)


class AuthenticationTests(Tier1TestCase):
    def test_login_session_and_logout_contract(self):
        client = server.app.test_client()
        session_response = client.get("/api/auth/session")
        self.assertEqual(session_response.status_code, 200)
        self.assertEqual(
            session_response.get_json(),
            {"ok": True, "authenticated": False, "user": None},
        )

        self.assert_api_error(
            client.post(
                "/api/auth/login",
                json={"username": "buyer", "password": "incorrect"},
            ),
            401,
        )
        login_response = client.post(
            "/api/auth/login",
            json={"username": "buyer", "password": "buyer123"},
        )
        self.assertEqual(login_response.status_code, 200)
        self.assertIn("HttpOnly", login_response.headers.get("Set-Cookie", ""))
        login_body = login_response.get_json()
        self.assertTrue(login_body["ok"])
        self.assertEqual(login_body["user"]["id"], "U-BUYER")
        self.assertEqual(login_body["user"]["username"], "buyer")
        self.assertEqual(login_body["user"]["role"], "buyer")
        self.assertIsNone(login_body["user"]["ownerId"])
        self.assertNotIn("password", json.dumps(login_body).lower())

        session_body = client.get("/api/auth/session").get_json()
        self.assertTrue(session_body["authenticated"])
        self.assertEqual(session_body["user"], login_body["user"])

        logout_response = client.post("/api/auth/logout")
        self.assertEqual(logout_response.status_code, 200)
        self.assertEqual(logout_response.get_json(), {"ok": True})
        self.assertFalse(client.get("/api/auth/session").get_json()["authenticated"])

    def test_all_demo_roles_have_the_expected_server_side_identity(self):
        expected = {
            "buyer": ("U-BUYER", None),
            "owner": ("U-OWNER", "O-100"),
            "admin": ("U-ADMIN", None),
        }
        for role, (user_id, owner_id) in expected.items():
            with self.subTest(role=role):
                client = self.client_for(role)
                user = client.get("/api/auth/session").get_json()["user"]
                self.assertEqual(user["id"], user_id)
                self.assertEqual(user["role"], role)
                self.assertEqual(user["ownerId"], owner_id)

    def test_unsigned_session_cookie_cannot_spoof_a_role(self):
        client = server.app.test_client()
        cookie_name = server.app.config.get("SESSION_COOKIE_NAME", "session")
        client.set_cookie(cookie_name, "forged-admin-session")
        body = client.get("/api/auth/session").get_json()
        self.assertFalse(body["authenticated"])
        self.assertIsNone(body["user"])


class AuthorizationTests(Tier1TestCase):
    def test_resource_owner_and_admin_boundaries_ignore_body_spoofing(self):
        anonymous = server.app.test_client()
        buyer = self.client_for("buyer")
        owner = self.client_for("owner")
        admin = self.client_for("admin")
        resource_id = f"R-TIER1-{uuid.uuid4().hex[:10]}"
        listing = {
            "id": resource_id,
            "name": "Tier 1 Test Press",
            "category": "Machinery",
            "cluster": "Peenya",
            "pricePerDay": 2500,
            "ownerId": "O-SPOOFED",
            "ownerName": "Spoofed Corporation",
            "role": "admin",
            "verified": True,
            "description": "Authorization boundary fixture for a 5-axis VMC with CNC machining",
            "tags": ["press", "test"],
        }

        self.assert_api_error(anonymous.post("/api/resources", json=listing), 401)
        self.assert_api_error(buyer.post("/api/resources", json=listing), 403)
        self.assert_api_error(admin.post("/api/resources", json=listing), 403)

        created = owner.post("/api/resources", json=listing)
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        created_id = created.get_json()["id"]
        resource = self.resource_by_id(created_id)
        self.assertIsNotNone(resource)
        self.assertEqual(resource["ownerId"], "O-100")
        self.assertNotEqual(resource["ownerName"], "Spoofed Corporation")
        self.assertFalse(resource["verified"])
        self.assertIn("CNC Machining", resource["capabilities"])

        owner_update = owner.patch(
            f"/api/resources/{created_id}",
            json={"pricePerDay": 2700, "availability": False},
        )
        self.assertEqual(owner_update.status_code, 200)
        updated = self.resource_by_id(created_id)
        self.assertEqual(updated["pricePerDay"], 2700)
        self.assertFalse(updated["availability"])

        self.assert_api_error(
            owner.patch(f"/api/resources/{created_id}", json={"verified": True}), 403
        )
        self.assert_api_error(
            owner.patch("/api/resources/R-LEGACY", json={"pricePerDay": 1}), 403
        )
        self.assert_api_error(
            buyer.patch(f"/api/resources/{created_id}", json={"availability": True}), 403
        )
        self.assert_api_error(
            admin.patch(f"/api/resources/{created_id}", json={"pricePerDay": 1}), 403
        )

        verified = admin.patch(f"/api/resources/{created_id}", json={"verified": True})
        self.assertEqual(verified.status_code, 200)
        self.assertTrue(self.resource_by_id(created_id)["verified"])

        self.assert_api_error(buyer.delete(f"/api/resources/{created_id}"), 403)
        self.assert_api_error(admin.delete(f"/api/resources/{created_id}"), 403)
        deleted = owner.delete(f"/api/resources/{created_id}")
        self.assertEqual(deleted.status_code, 200)
        self.assertIsNone(self.resource_by_id(created_id))

    def test_only_buyer_can_create_complete_and_rate_a_booking(self):
        anonymous = server.app.test_client()
        buyer = self.client_for("buyer")
        owner = self.client_for("owner")
        admin = self.client_for("admin")
        payload = {
            "resourceIds": ["R-LEGACY"],
            "buyer": "Forged Buyer Name",
            "role": "admin",
        }

        self.assert_api_error(anonymous.post("/api/bookings", json=payload), 401)
        self.assert_api_error(owner.post("/api/bookings", json=payload), 403)
        self.assert_api_error(admin.post("/api/bookings", json=payload), 403)

        conn = sqlite3.connect(TEST_DB_PATH)
        try:
            conn.execute("UPDATE resources SET verified = 0 WHERE id = 'R-LEGACY'")
            conn.commit()
        finally:
            conn.close()
        unverified = buyer.post("/api/bookings", json=payload)
        self.assert_api_error(unverified, 409)
        self.assertEqual(unverified.get_json()["error"]["code"], "resource_unverified")
        conn = sqlite3.connect(TEST_DB_PATH)
        try:
            conn.execute("UPDATE resources SET verified = 1 WHERE id = 'R-LEGACY'")
            conn.commit()
        finally:
            conn.close()

        created = buyer.post("/api/bookings", json=payload)
        self.assertEqual(created.status_code, 200, created.get_data(as_text=True))
        booking_id = created.get_json()["id"]
        self.assertEqual(anonymous.get("/api/bookings").get_json(), [])
        self.assertEqual(owner.get("/api/bookings").get_json(), [])
        self.assertEqual(admin.get("/api/bookings").get_json(), [])
        buyer_booking_ids = {
            booking["id"] for booking in buyer.get("/api/bookings").get_json()
        }
        self.assertIn(booking_id, buyer_booking_ids)
        unavailable = buyer.post("/api/bookings", json=payload)
        self.assert_api_error(unavailable, 409)
        self.assertEqual(unavailable.get_json()["error"]["code"], "resource_unavailable")

        conn = sqlite3.connect(TEST_DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            stored = conn.execute(
                "SELECT * FROM bookings WHERE id = ?", (booking_id,)
            ).fetchone()
            self.assertIsNotNone(stored)
            self.assertNotEqual(stored["buyer"], "Forged Buyer Name")
            if "buyer_id" in stored.keys():
                self.assertEqual(stored["buyer_id"], "U-BUYER")
        finally:
            conn.close()

        self.assert_api_error(
            owner.patch(f"/api/bookings/{booking_id}", json={"action": "complete"}), 403
        )
        self.assert_api_error(
            admin.patch(f"/api/bookings/{booking_id}", json={"action": "complete"}), 403
        )

        # A buyer role alone is not enough: record ownership is enforced too.
        conn = sqlite3.connect(TEST_DB_PATH)
        try:
            conn.execute(
                "UPDATE bookings SET buyer_id = 'U-SOMEONE-ELSE' WHERE id = ?",
                (booking_id,),
            )
            conn.commit()
        finally:
            conn.close()
        self.assert_api_error(
            buyer.patch(f"/api/bookings/{booking_id}", json={"action": "complete"}), 403
        )
        buyer_booking_ids = {
            booking["id"] for booking in buyer.get("/api/bookings").get_json()
        }
        self.assertNotIn(booking_id, buyer_booking_ids)
        conn = sqlite3.connect(TEST_DB_PATH)
        try:
            conn.execute(
                "UPDATE bookings SET buyer_id = 'U-BUYER' WHERE id = ?", (booking_id,)
            )
            conn.commit()
        finally:
            conn.close()

        completed = buyer.patch(
            f"/api/bookings/{booking_id}", json={"action": "complete"}
        )
        self.assertEqual(completed.status_code, 200)
        rated = buyer.patch(
            f"/api/bookings/{booking_id}", json={"action": "rate", "rating": 5}
        )
        self.assertEqual(rated.status_code, 200)


class TypeaheadAndExplainTests(Tier1TestCase):
    def test_typeahead_is_grounded_fast_read_only_and_confidence_scored(self):
        anonymous = server.app.test_client()
        buyer = self.client_for("buyer")
        owner = self.client_for("owner")
        admin = self.client_for("admin")
        payload = {
            "text": "Need CNC machining in Peenya under 3000 per day",
            "role": "admin",
            "context": {"source": "search", "material": ""},
        }
        before = self.production_request_count()

        self.assert_api_error(anonymous.post("/api/copilot/typeahead", json=payload), 401)
        self.assert_api_error(admin.post("/api/copilot/typeahead", json=payload), 403)
        owner_response = owner.post("/api/copilot/typeahead", json=payload)
        self.assertEqual(owner_response.status_code, 200, owner_response.get_data(as_text=True))
        response = buyer.post("/api/copilot/typeahead", json=payload)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()

        self.assertTrue(body["ok"])
        self.assertIsInstance(body["completion"], str)
        self.assertIsInstance(body["fields"], dict)
        self.assertIsInstance(body["matches"], list)
        self.assertIn("engine", body)
        self.assertIsInstance(body["durationMs"], (int, float))
        self.assertLess(body["durationMs"], 300)
        self.assertLessEqual(len(body["matches"]), 3)
        self.assertTrue(body["fields"])
        for field in body["fields"].values():
            self.assertIsInstance(field, dict)
            self.assertIn("value", field)
            self.assertIn("confidence", field)
            self.assertIsInstance(field["confidence"], (int, float))
            self.assertGreaterEqual(field["confidence"], 0)
            self.assertLessEqual(field["confidence"], 1)

        catalogue_ids = {
            item["id"] for item in server.app.test_client().get("/api/resources").get_json()
        }
        for match in body["matches"]:
            self.assertIn(match["id"], catalogue_ids)
            self.assertIn("match", match)
            self.assert_explanation(match["match"])

        # Compose is a read-only suggestion path, even when the body claims an
        # elevated role.  It must not create a planner request as a side effect.
        self.assertEqual(self.production_request_count(), before)

        canonical = buyer.post(
            "/api/copilot/typeahead",
            json={
                "text": "Need a verified CNC in Peenya under Rs 9000 for 3 days",
                "context": {"source": "search", "form": {}},
            },
        ).get_json()
        self.assertEqual(canonical["fields"]["deadline"]["value"], 3)
        self.assertEqual(
            canonical["fields"]["processes"]["value"], "CNC Machining"
        )
        self.assertTrue(canonical["matches"])
        self.assertEqual(canonical["matches"][0]["id"], "R-LEGACY")
        self.assertTrue(
            all(item["category"] != "Logistics Vehicle" for item in canonical["matches"])
        )

        cmm = owner.post(
            "/api/copilot/typeahead",
            json={
                "text": "List a verified CMM inspection machine in Peenya",
                "context": {"source": "listing", "form": {}},
            },
        ).get_json()["fields"]
        self.assertEqual(cmm["category"]["value"], "Testing Equipment")
        self.assertIn("Quality Inspection", cmm["processes"]["value"])
        self.assertNotIn("CNC Machining", cmm["processes"]["value"])
        self.assertEqual(
            server.parse_production_requirement({"processes": "CMM inspection machine"}),
            ["Quality Inspection"],
        )

        bhosari_cnc = buyer.post(
            "/api/copilot/typeahead",
            json={
                "text": "Need CNC in Bhosari under Rs 7000",
                "context": {"source": "search", "form": {}},
            },
        ).get_json()
        self.assertEqual(
            bhosari_cnc["matches"], [],
            "A generic Machinery capability must not mask a missing CNC capability.",
        )

        observed_only = buyer.post(
            "/api/copilot/typeahead",
            json={"text": "CNC in Peenya", "context": {"source": "planner"}},
        ).get_json()["fields"]
        for unobserved_default in ("quantity", "budget", "deadline", "material"):
            self.assertNotIn(unobserved_default, observed_only)
        self.assertEqual(self.production_request_count(), before)

    def test_optional_cloud_stream_is_cancellable_enhancement_not_a_write(self):
        buyer = self.client_for("buyer")
        before = self.production_request_count()
        local_only = buyer.post(
            "/api/copilot/typeahead/stream",
            json={"text": "Need CNC", "context": {"source": "search"}},
        )
        self.assertEqual(local_only.status_code, 204)
        with patch.dict(os.environ, {"GROQ_API_KEY": "test-key"}), patch.object(
            server,
            "stream_compose_completion",
            return_value=(iter([" under", " budget"]), "hybrid-groq"),
        ):
            response = buyer.post(
                "/api/copilot/typeahead/stream",
                json={
                    "text": "Need CNC in Peenya",
                    "context": {"source": "search", "form": {}},
                },
                buffered=True,
            )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.mimetype, "text/event-stream")
        stream = response.get_data(as_text=True)
        self.assertIn("event: meta", stream)
        self.assertIn("event: token", stream)
        self.assertIn('"completion": " under budget"', stream)
        self.assertEqual(self.production_request_count(), before)

    def test_search_and_planner_keep_legacy_shapes_and_add_explanations(self):
        match_response = server.app.test_client().post(
            "/api/match",
            json={
                "search": "CNC steel machining",
                "resourceType": "Machinery",
                "cluster": "Peenya",
                "budget": 5000,
                "availableOnly": True,
            },
        )
        self.assertEqual(match_response.status_code, 200)
        match_body = match_response.get_json()
        self.assertTrue(match_body["ok"])
        self.assertIn("engine", match_body)
        self.assertIsInstance(match_body["results"], list)
        self.assertTrue(match_body["results"])
        first_match = match_body["results"][0]
        self.assertTrue(
            {
                "id",
                "name",
                "category",
                "cluster",
                "pricePerDay",
                "verified",
                "availability",
                "match",
            }.issubset(first_match)
        )
        self.assertIn("score", first_match["match"])
        self.assertIn("breakdown", first_match["match"])
        self.assert_explanation(first_match["match"])
        self.assert_explanation(first_match["match"]["breakdown"])

        owner = self.client_for("owner")
        admin = self.client_for("admin")
        buyer = self.client_for("buyer")
        plan_payload = {
            "productName": "Steel bracket",
            "quantity": 20,
            "material": "steel",
            "processes": "CNC machining",
            "deadline": 7,
            "budget": 15000,
            "cluster": "Peenya",
        }
        self.assert_api_error(owner.post("/api/production/plan", json=plan_payload), 403)
        self.assert_api_error(admin.post("/api/production/plan", json=plan_payload), 403)
        before_plans = self.production_request_count()
        plan_response = buyer.post("/api/production/plan", json=plan_payload)
        self.assertEqual(plan_response.status_code, 200, plan_response.get_data(as_text=True))
        plan_body = plan_response.get_json()
        self.assertTrue(plan_body["ok"])
        self.assertTrue({"requestId", "requirements", "bundle"}.issubset(plan_body))
        self.assertTrue(
            {"capabilities", "chain", "options", "feasible", "decisionAnalysis"}.issubset(
                plan_body["bundle"]
            )
        )
        self.assertTrue(plan_body["bundle"]["chain"])
        chain_item = plan_body["bundle"]["chain"][0]
        self.assertTrue(
            {"capability", "resource", "scoreBreakdown", "estimatedTransport"}.issubset(
                chain_item
            )
        )
        self.assert_explanation(chain_item)
        self.assert_explanation(chain_item["scoreBreakdown"])
        second_plan = buyer.post("/api/production/plan", json=plan_payload)
        self.assertEqual(second_plan.status_code, 200, second_plan.get_data(as_text=True))
        self.assertNotEqual(plan_body["requestId"], second_plan.get_json()["requestId"])
        self.assertEqual(self.production_request_count(), before_plans + 2)

    def test_existing_public_read_endpoint_shapes_remain_compatible(self):
        client = server.app.test_client()
        expectations = {
            "/api/health": dict,
            "/api/dashboard": dict,
            "/api/resources": list,
            "/api/bookings": list,
            "/api/notifications": list,
            "/api/analytics": dict,
            "/api/clusters": list,
            "/api/ai/status": dict,
        }
        for path, expected_type in expectations.items():
            with self.subTest(path=path):
                response = client.get(path)
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
                self.assertIsInstance(response.get_json(), expected_type)

        dashboard = client.get("/api/dashboard").get_json()
        self.assertTrue(
            {
                "resources_listed",
                "available_resources",
                "pending_verifications",
                "verified_msmes",
                "average_cost_per_day",
                "active_bookings",
                "capex_avoided",
            }.issubset(dashboard)
        )
        resource = client.get("/api/resources").get_json()[0]
        self.assertTrue(
            {
                "id",
                "name",
                "category",
                "cluster",
                "pricePerDay",
                "verified",
                "rating",
                "availability",
                "ownerId",
                "ownerName",
                "description",
                "tags",
            }.issubset(resource)
        )


class Tier2ActAndRealtimeTests(Tier1TestCase):
    def database_write_counts(self):
        return {
            table: self.table_count(table)
            for table in (
                "resources",
                "bookings",
                "notifications",
                "production_requests",
                "copilot_confirmations",
                "audit_logs",
            )
        }

    def test_act_permissions_and_search_draft_are_read_only(self):
        payload = {"instruction": "Find verified CNC capacity in Peenya under Rs 9000"}
        self.assert_api_error(
            server.app.test_client().post("/api/copilot/act", json=payload),
            401,
        )
        self.assert_api_error(
            self.client_for("admin").post("/api/copilot/act", json=payload),
            403,
        )

        buyer = self.client_for("buyer")
        before = self.database_write_counts()
        response = buyer.post("/api/copilot/act", json=payload)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["action"], "searchResources")
        self.assertFalse(body["confirmable"])
        self.assertFalse(body["requiresConfirmation"])
        self.assertIsNone(body["confirmationToken"])
        self.assertIsInstance(body["draft"], dict)
        self.assertIsInstance(body["matches"], list)
        catalogue_ids = {
            item["id"] for item in server.app.test_client().get("/api/resources").get_json()
        }
        self.assertTrue(all(item["id"] in catalogue_ids for item in body["matches"]))
        self.assertEqual(self.database_write_counts(), before)

    def test_counted_booking_requires_token_and_confirms_exactly_once(self):
        first_id = self.insert_bookable_resource(
            name="Tier 2 CNC Cell Alpha", price_per_day=2100
        )
        second_id = self.insert_bookable_resource(
            name="Tier 2 CNC Cell Beta", price_per_day=2200
        )
        buyer = self.client_for("buyer")
        before = self.database_write_counts()
        response = buyer.post(
            "/api/copilot/act",
            json={
                "instruction": (
                    "Find me 2 CNC machines in Peenya under Rs 2500/day "
                    "available next week"
                )
            },
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        body = response.get_json()
        self.assertEqual(body["action"], "createBooking")
        self.assertTrue(body["confirmable"])
        self.assertTrue(body["requiresConfirmation"])
        self.assertEqual(body["draft"]["requestedResourceCount"], 2)
        self.assertEqual(set(body["draft"]["resourceIds"]), {first_id, second_id})
        self.assertEqual(len(body["draft"]["resourceIds"]), 2)
        self.assertTrue(all(item["verified"] and item["availability"] for item in body["matches"]))
        token = body["confirmationToken"]
        self.assertIsInstance(token, str)
        self.assertGreater(len(token), 40)

        # Drafting, including issuing the signed token, is database read-only.
        self.assertEqual(self.database_write_counts(), before)
        self.assertTrue(self.resource_by_id(first_id)["availability"])
        self.assertTrue(self.resource_by_id(second_id)["availability"])

        # A copied token is bound to the login that requested the draft.
        other_buyer_login = self.client_for("buyer")
        self.assert_api_error(
            other_buyer_login.post(
                "/api/copilot/act/confirm", json={"confirmationToken": token}
            ),
            403,
        )
        self.assertEqual(self.database_write_counts(), before)

        # Changing the signature is rejected before any marketplace write.
        token_parts = token.split(".")
        signature = token_parts[-1]
        token_parts[-1] = ("A" if signature[:1] != "A" else "B") + signature[1:]
        tampered = ".".join(token_parts)
        self.assert_api_error(
            buyer.post(
                "/api/copilot/act/confirm", json={"confirmationToken": tampered}
            ),
            400,
        )
        self.assertEqual(self.database_write_counts(), before)

        # A forged visible draft is ignored; only the server-signed token is used.
        confirmed = buyer.post(
            "/api/copilot/act/confirm",
            json={
                "confirmationToken": token,
                "draft": {"resourceIds": ["R-LEGACY"], "buyer": "Forged"},
            },
        )
        self.assertEqual(confirmed.status_code, 201, confirmed.get_data(as_text=True))
        confirmed_body = confirmed.get_json()
        booking_id = confirmed_body["id"]
        conn = sqlite3.connect(TEST_DB_PATH)
        try:
            stored = conn.execute(
                "SELECT buyer_id, resources_json FROM bookings WHERE id = ?",
                (booking_id,),
            ).fetchone()
        finally:
            conn.close()
        self.assertEqual(stored[0], "U-BUYER")
        self.assertEqual(set(json.loads(stored[1])), {first_id, second_id})
        self.assertFalse(self.resource_by_id(first_id)["availability"])
        self.assertFalse(self.resource_by_id(second_id)["availability"])
        self.assertEqual(self.table_count("bookings"), before["bookings"] + 1)
        self.assertEqual(
            self.table_count("copilot_confirmations"),
            before["copilot_confirmations"] + 1,
        )

        replay = buyer.post(
            "/api/copilot/act/confirm", json={"confirmationToken": token}
        )
        self.assert_api_error(replay, 409)
        self.assertEqual(replay.get_json()["error"]["code"], "proposal_already_confirmed")
        self.assertEqual(self.table_count("bookings"), before["bookings"] + 1)

    def test_booking_confirmation_revalidates_live_availability(self):
        resource_id = self.insert_bookable_resource(
            name="Tier 2 Revalidation CNC", price_per_day=2300
        )
        buyer = self.client_for("buyer")
        proposal = buyer.post(
            "/api/copilot/act",
            json={"instruction": f"Book resource {resource_id}"},
        ).get_json()
        self.assertTrue(proposal["confirmable"])
        before_bookings = self.table_count("bookings")
        before_confirmations = self.table_count("copilot_confirmations")
        conn = sqlite3.connect(TEST_DB_PATH)
        try:
            conn.execute(
                "UPDATE resources SET availability = 0 WHERE id = ?", (resource_id,)
            )
            conn.commit()
        finally:
            conn.close()

        response = buyer.post(
            "/api/copilot/act/confirm",
            json={"confirmationToken": proposal["confirmationToken"]},
        )
        self.assert_api_error(response, 409)
        self.assertEqual(response.get_json()["error"]["code"], "resource_unavailable")
        self.assertEqual(self.table_count("bookings"), before_bookings)
        self.assertEqual(self.table_count("copilot_confirmations"), before_confirmations)

    def test_owner_listing_draft_is_unverified_and_directory_is_extensible(self):
        custom_cluster = f"Tier Two Extension {uuid.uuid4().hex[:6]}"
        conn = sqlite3.connect(TEST_DB_PATH)
        try:
            conn.execute(
                """
                INSERT INTO industrial_clusters (name, city, state, region)
                VALUES (?, ?, ?, ?)
                """,
                (custom_cluster, "Fixture City", "Karnataka", "South"),
            )
            conn.commit()
        finally:
            conn.close()
        owner = self.client_for("owner")
        before = self.database_write_counts()
        proposal_response = owner.post(
            "/api/copilot/act",
            json={
                "instruction": (
                    f"List my laser cutting cell in {custom_cluster} "
                    "at Rs 3200/day"
                )
            },
        )
        self.assertEqual(
            proposal_response.status_code,
            200,
            proposal_response.get_data(as_text=True),
        )
        proposal = proposal_response.get_json()
        self.assertEqual(proposal["action"], "createListing")
        self.assertTrue(proposal["confirmable"])
        self.assertEqual(proposal["draft"]["cluster"], custom_cluster)
        self.assertEqual(proposal["draft"]["pricePerDay"], 3200)
        self.assertEqual(self.database_write_counts(), before)

        response = owner.post(
            "/api/copilot/act/confirm",
            json={
                "confirmationToken": proposal["confirmationToken"],
                "draft": {
                    "ownerId": "O-SPOOFED",
                    "verified": True,
                    "pricePerDay": 1,
                },
            },
        )
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        created = self.resource_by_id(response.get_json()["id"])
        self.assertEqual(created["ownerId"], "O-100")
        self.assertEqual(created["cluster"], custom_cluster)
        self.assertEqual(created["pricePerDay"], 3200)
        self.assertFalse(created["verified"])

    def test_sse_is_authenticated_bounded_and_filters_targeted_events(self):
        anonymous = server.app.test_client().get("/api/events?after=0&once=1")
        self.assert_api_error(anonymous, 401)
        buyer = self.client_for("buyer")
        admin = self.client_for("admin")
        marker = uuid.uuid4().hex[:10]
        public_title = f"Public live event {marker}"
        admin_title = f"Admin-only live event {marker}"
        conn = server.get_db()
        try:
            cursor = conn.execute(
                "SELECT COALESCE(MAX(rowid), 0) FROM notifications"
            ).fetchone()[0]
            server.add_notification(
                conn, public_title, "Visible to signed-in roles", "availability"
            )
            server.add_notification(
                conn,
                admin_title,
                "Verification queue detail",
                "verification",
                recipient_role="admin",
            )
            conn.commit()
        finally:
            conn.close()

        buyer_response = buyer.get(
            f"/api/events?after={cursor}&once=1", buffered=True
        )
        self.assertEqual(buyer_response.status_code, 200)
        self.assertEqual(buyer_response.mimetype, "text/event-stream")
        self.assertIn("no-cache, no-store", buyer_response.headers["Cache-Control"])
        buyer_stream = buyer_response.get_data(as_text=True)
        self.assertIn("event: ready", buyer_stream)
        self.assertIn(public_title, buyer_stream)
        self.assertNotIn(admin_title, buyer_stream)

        admin_stream = admin.get(
            f"/api/events?after={cursor}&once=1", buffered=True
        ).get_data(as_text=True)
        self.assertIn(public_title, admin_stream)
        self.assertIn(admin_title, admin_stream)

        anonymous_feed = server.app.test_client().get("/api/notifications").get_data(
            as_text=True
        )
        buyer_feed = buyer.get("/api/notifications").get_data(as_text=True)
        admin_feed = admin.get("/api/notifications").get_data(as_text=True)
        self.assertIn(public_title, anonymous_feed)
        self.assertNotIn(admin_title, anonymous_feed)
        self.assertNotIn(admin_title, buyer_feed)
        self.assertIn(admin_title, admin_feed)

        # A short, bounded stream lifetime forces a fresh cookie/session check,
        # so logging out in another tab cannot leave an authorized feed open.
        with patch.object(server, "SSE_CONNECTION_MAX_SECONDS", 0):
            rotated = buyer.get(
                f"/api/events?after={cursor}", buffered=True
            ).get_data(as_text=True)
        self.assertIn("event: reconnect", rotated)


class Tier2SemanticAndClientAssetTests(Tier1TestCase):
    def test_multilingual_voice_transcripts_feed_the_same_local_compose_path(self):
        resource_id = self.insert_bookable_resource(
            name="Multilingual Voice CNC", price_per_day=2500
        )
        self.addCleanup(self.delete_test_resource, resource_id)
        buyer = self.client_for("buyer")
        transcripts = {
            "Hindi": "मुझे पीण्या में सत्यापित सीएनसी मशीन 3000 रुपये प्रति दिन अगले सप्ताह उपलब्ध चाहिए",
            "Tamil": "பீன்யாவில் சரிபார்க்கப்பட்ட சிஎன்சி இயந்திரம் 3000 ரூபாய் ஒரு நாளுக்கு அடுத்த வாரம் கிடைக்கும்",
            "Telugu": "పీన్యాలో ధృవీకరించబడిన సిఎన్సి యంత్రం 3000 రూపాయలు రోజుకు వచ్చే వారం అందుబాటులో",
        }
        for language, transcript in transcripts.items():
            with self.subTest(language=language):
                response = buyer.post(
                    "/api/copilot/typeahead",
                    json={"text": transcript, "context": {"source": "search"}},
                )
                self.assertEqual(
                    response.status_code, 200, response.get_data(as_text=True)
                )
                body = response.get_json()
                self.assertEqual(body["fields"]["cluster"]["value"], "Peenya")
                self.assertEqual(body["fields"]["category"]["value"], "Machinery")
                self.assertEqual(body["fields"]["budget"]["value"], 3000)
                self.assertEqual(body["fields"]["deadline"]["value"], 7)
                self.assertEqual(
                    body["fields"]["processes"]["value"], "CNC Machining"
                )
                self.assertTrue(body["fields"]["verifiedOnly"]["value"])
                self.assertTrue(body["fields"]["availableOnly"]["value"])
                self.assertIn(resource_id, {item["id"] for item in body["matches"]})

    def test_hybrid_semantic_rank_handles_typos_and_reports_its_fallback(self):
        cnc = {
            "id": "R-SEM-CNC",
            "name": "Precision CNC Machining Centre",
            "category": "Machinery",
            "cluster": "Peenya",
            "description": "Five axis milling and turning",
            "ownerName": "Fixture Works",
            "tags": ["cnc", "milling"],
            "capabilities": ["CNC Machining"],
        }
        warehouse = {
            "id": "R-SEM-WH",
            "name": "Cold Storage Warehouse",
            "category": "Warehouse Space",
            "cluster": "Bhosari",
            "description": "Refrigerated storage bay",
            "ownerName": "Fixture Logistics",
            "tags": ["cold-chain"],
            "capabilities": ["Storage"],
        }
        ranked = server.semantic_rank(
            "precision machning centre", [warehouse, cnc], limit=2
        )
        self.assertTrue(ranked)
        self.assertEqual(ranked[0]["resource"]["id"], cnc["id"])
        metadata = ranked[0]["metadata"]
        self.assertEqual(metadata["method"], "hybrid-tfidf-subword-v1")
        self.assertTrue(metadata["localOnly"])
        self.assertGreater(metadata["subwordScore"], 0)
        self.assertEqual(set(metadata["weights"]), {"lexical", "subword"})
        status = server.engine_status()
        self.assertEqual(status["semanticRanker"]["id"], "hybrid-tfidf-subword-v1")
        self.assertEqual(status["semanticRanker"]["fallback"], "lexical-tfidf")

    def test_voice_act_and_pwa_assets_preserve_the_safety_boundaries(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        javascript = (ROOT / "app.js").read_text(encoding="utf-8")
        service_worker = (ROOT / "sw.js").read_text(encoding="utf-8")
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))

        for language in ("en-IN", "hi-IN", "ta-IN", "te-IN"):
            self.assertIn(f'value="{language}"', html)
        self.assertIn("window.SpeechRecognition || window.webkitSpeechRecognition", javascript)
        self.assertIn('dispatchEvent(new Event("input", { bubbles: true }))', javascript)
        self.assertIn("detectTranscriptLanguage", javascript)
        self.assertIn('JSON.stringify({ confirmationToken: token })', javascript)
        self.assertIn("new EventSource", javascript)
        self.assertIn("enterOfflineReadOnly", javascript)

        for public_path in (
            "/api/resources",
            "/api/dashboard",
            "/api/clusters",
            "/api/analytics",
            "/api/ai/status",
        ):
            self.assertIn(f'"{public_path}"', service_worker)
        for sensitive_path in (
            "/api/auth/",
            "/api/bookings",
            "/api/notifications",
            "/api/events",
            "/api/copilot/",
            "/api/production/",
        ):
            self.assertIn(f'"{sensitive_path}"', service_worker)
        self.assertIn('request.method !== "GET"', service_worker)
        self.assertIn("isCanonicalAppEntry", service_worker)
        self.assertIn("SHELL_PATHS.has(url.pathname)", service_worker)
        self.assertEqual(manifest["display"], "standalone")
        self.assertEqual(manifest["scope"], "/")
        self.assertTrue(manifest["icons"])
        self.assertIn("maskable", manifest["icons"][0]["purpose"])


class Tier3ProductizationTests(Tier1TestCase):
    def test_analytics_uses_booking_dates_utilization_and_disclosed_distance_proxy(self):
        baseline = server.app.test_client().get("/api/analytics").get_json()
        marker = uuid.uuid4().hex[:10].upper()
        resource_id = f"R-TIER3-{marker}"
        booking_ids = [
            f"B-TIER3-A-{marker}",
            f"B-TIER3-B-{marker}",
            f"B-TIER3-C-{marker}",
            f"B-TIER3-BAD-{marker}",
        ]
        conn = sqlite3.connect(TEST_DB_PATH)
        try:
            conn.execute(
                """
                INSERT INTO resources
                (id, name, category, cluster, price_per_day, verified, rating,
                 availability, owner_id, owner_name, description, tags,
                 created_at, capabilities, utilization, transport_rate,
                 total_capacity, available_capacity)
                VALUES (?, ?, 'Machinery', 'Peenya', 2400, 1, 4.8, 1,
                        'O-TIER3-FIXTURE', 'Tier 3 Fixture Works', ?, ?, ?, ?,
                        80, 300, 100, 20)
                """,
                (
                    resource_id,
                    "Tier 3 Analytics Mill",
                    "Analytics fixture with recorded utilization and transport rate.",
                    json.dumps(["analytics", "cnc"]),
                    "2031-01-10",
                    json.dumps(["CNC Machining"]),
                ),
            )
            for booking_id, status, created_at in (
                (booking_ids[0], "Requested", "2031-02-14"),
                (booking_ids[1], "Cancelled", "2031-03-12"),
                (booking_ids[2], "Completed", "2031-04-02T09:30:00"),
            ):
                conn.execute(
                    """
                    INSERT INTO bookings
                    (id, buyer, status, total, created_at, rating,
                     resources_json, note, buyer_id)
                    VALUES (?, 'Tier 3 Buyer', ?, 2400, ?, NULL, ?, ?, 'U-BUYER')
                    """,
                    (
                        booking_id,
                        status,
                        created_at,
                        json.dumps([resource_id, resource_id]),
                        "Tier 3 analytics fixture",
                    ),
                )
            conn.execute(
                """
                INSERT INTO bookings
                (id, buyer, status, total, created_at, rating,
                 resources_json, note, buyer_id)
                VALUES (?, 'Tier 3 Buyer', 'Cancelled', 0, 'not-a-date',
                        NULL, '{bad-json', 'Malformed legacy fixture', 'U-BUYER')
                """,
                (booking_ids[3],),
            )
            conn.commit()
        finally:
            conn.close()

        def remove_fixtures():
            cleanup_conn = sqlite3.connect(TEST_DB_PATH)
            try:
                cleanup_conn.executemany(
                    "DELETE FROM bookings WHERE id = ?",
                    [(booking_id,) for booking_id in booking_ids],
                )
                cleanup_conn.execute("DELETE FROM resources WHERE id = ?", (resource_id,))
                cleanup_conn.commit()
            finally:
                cleanup_conn.close()

        self.addCleanup(remove_fixtures)
        response = server.app.test_client().get("/api/analytics")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        analytics = response.get_json()

        self.assertEqual(analytics["trendPeriods"], ["2031-01", "2031-02", "2031-03", "2031-04"])
        self.assertEqual(analytics["trendLabels"], ["Jan", "Feb", "Mar", "Apr"])
        self.assertEqual(analytics["trend"], [0, 1, 1, 1])
        self.assertEqual(analytics["trendMovingAverage"], [0.0, 0.5, 0.67, 1.0])
        self.assertEqual(analytics["trendBreakdown"]["anchorSource"], "latest_valid_booking")
        self.assertEqual(
            analytics["trendBreakdown"]["invalidDatedBookings"],
            baseline["trendBreakdown"]["invalidDatedBookings"] + 1,
        )

        baseline_demand = dict(zip(baseline["categories"], baseline["demand"]))
        demand = dict(zip(analytics["categories"], analytics["demand"]))
        self.assertEqual(demand["Machinery"], baseline_demand["Machinery"] + 2)
        self.assertEqual(
            analytics["demandBreakdown"]["malformedResourceLists"],
            baseline["demandBreakdown"]["malformedResourceLists"] + 1,
        )

        baseline_carbon = baseline["carbonBreakdown"]
        carbon = analytics["carbonBreakdown"]
        self.assertAlmostEqual(carbon["grossAvoidedKg"] - baseline_carbon["grossAvoidedKg"], 76.8, places=2)
        self.assertAlmostEqual(carbon["transportEmissionsKg"] - baseline_carbon["transportEmissionsKg"], 1.8, places=2)
        self.assertAlmostEqual(analytics["carbonSavings"] - baseline["carbonSavings"], 75.0, places=1)
        self.assertEqual(analytics["carbonSavingsUnit"], "kgCO2e")
        self.assertEqual(carbon["distanceBasis"], "estimated_proxy_not_observed")
        self.assertFalse(carbon["observedDistanceAvailable"])
        carbon_method = analytics["assumptions"]["carbonSavings"]
        self.assertIn("transport_rate in INR", carbon_method["distanceProxy"])
        self.assertIn("not measured", carbon_method["caveat"])

    def test_webmcp_is_progressive_bounded_and_cannot_confirm_a_write(self):
        javascript = (ROOT / "app.js").read_text(encoding="utf-8")
        start = javascript.index("function webMcpResponse")
        end = javascript.index("const voiceControllers", start)
        webmcp = javascript[start:end]

        self.assertIn("document.modelContext || navigator.modelContext", webmcp)
        self.assertIn('typeof modelContext.registerTool !== "function"', webmcp)
        for tool_name in (
            "frep_catalogue_summary",
            "frep_filter_resources",
            "frep_search_resources",
            "frep_review_booking_draft",
        ):
            self.assertIn(f'name: "{tool_name}"', webmcp)
        self.assertIn("maximum: 10", webmcp)
        self.assertIn("requestCopilotActionDraft", webmcp)
        self.assertIn("readOnlyHint: true", webmcp)
        self.assertNotRegex(webmcp, r"confirmationToken\s*:")
        self.assertNotIn("confirmCopilotAction", webmcp)
        self.assertNotIn("copilotActConfirm", webmcp)
        self.assertNotIn("submitBooking", webmcp)
        self.assertNotIn('fetchJson("/api/bookings"', webmcp)
        self.assertIn("initializeWebMcpTools().catch(() => {})", javascript)

    def test_docker_contract_is_non_root_persistent_and_excludes_local_data(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        dockerignore = (ROOT / ".dockerignore").read_text(encoding="utf-8")

        self.assertIn("FROM python:3.12.11-slim-bookworm", dockerfile)
        self.assertIn("USER frep:frep", dockerfile)
        self.assertIn("HEALTHCHECK", dockerfile)
        self.assertIn('CMD ["gunicorn"', dockerfile)
        self.assertIn("FREP_DB_PATH=/var/lib/frep/frep.db", dockerfile)
        self.assertNotIn("COPY .", dockerfile)
        self.assertIn("frep_data:/var/lib/frep", compose)
        self.assertIn("FREP_SECRET_KEY", compose)
        self.assertIn("no-new-privileges:true", compose)
        self.assertIn("cap_drop", compose)
        ignore_rules = [
            line.strip()
            for line in dockerignore.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertEqual(ignore_rules[0], "**")
        self.assertNotIn("!frep.db", dockerignore)

    def test_theme_is_accessible_persistent_and_updates_offline_shell_version(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        javascript = (ROOT / "app.js").read_text(encoding="utf-8")
        css = (ROOT / "styles.css").read_text(encoding="utf-8")
        service_worker = (ROOT / "sw.js").read_text(encoding="utf-8")

        self.assertIn('id="themeToggle"', html)
        self.assertIn('aria-pressed="false"', html)
        self.assertIn('window.matchMedia?.("(prefers-color-scheme: light)")', javascript)
        self.assertIn('localStorage.setItem("frep-theme", selected)', javascript)
        self.assertIn('toggle.setAttribute("aria-pressed"', javascript)
        self.assertIn('meta[name="theme-color"]', javascript)
        self.assertIn('[data-theme="light"]', css)
        self.assertIn("color-scheme: light", css)
        self.assertIn('const CACHE_VERSION = "v5"', service_worker)


if __name__ == "__main__":
    unittest.main(verbosity=2)
