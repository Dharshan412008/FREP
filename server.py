import os
import json
import math
import re
import secrets
import sqlite3
import uuid
from functools import wraps
from time import perf_counter, sleep
from datetime import datetime, timedelta
from flask import Flask, Response, g, jsonify, request, send_from_directory, session, stream_with_context
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash

from ai_engine import (
    answer_query,
    contextual_completion,
    engine_status,
    extract_partial_fields,
    infer_capabilities_from_text,
    parse_requirement,
    semantic_rank,
    stream_compose_completion,
)

app = Flask(__name__, static_folder=None)
app.config.update(
    # A fresh fallback is safer than a checked-in signing secret. Operators can
    # set FREP_SECRET_KEY when sessions should survive process restarts.
    SECRET_KEY=os.environ.get("FREP_SECRET_KEY") or secrets.token_urlsafe(32),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("FREP_SECURE_COOKIES", "").strip().lower() in {"1", "true", "yes", "on"},
)
APP_ROOT = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIST = os.path.join(APP_ROOT, "frontend", "dist")
FRONTEND_ASSETS = os.path.join(FRONTEND_DIST, "assets")

# FREP_DB_PATH is primarily useful for isolated automated tests.  The normal
# local application continues to use the checked-in SQLite file.
DB_PATH = os.environ.get("FREP_DB_PATH", os.path.join(APP_ROOT, "frep.db"))

# Major Indian manufacturing and MSME hubs. Kept separately from listings so a
# location stays available even before an owner adds a resource there.
INDUSTRIAL_CLUSTERS = [
    ("Peenya", "Bengaluru", "Karnataka", "South"), ("Hosur", "Hosur", "Tamil Nadu", "South"),
    ("Chennai", "Chennai", "Tamil Nadu", "South"), ("Sriperumbudur", "Kanchipuram", "Tamil Nadu", "South"),
    ("Coimbatore", "Coimbatore", "Tamil Nadu", "South"), ("Tiruppur", "Tiruppur", "Tamil Nadu", "South"),
    ("Hyderabad", "Hyderabad", "Telangana", "South"), ("Visakhapatnam", "Visakhapatnam", "Andhra Pradesh", "South"),
    ("Bhosari", "Pune", "Maharashtra", "West"), ("Chakan", "Pune", "Maharashtra", "West"),
    ("Nashik", "Nashik", "Maharashtra", "West"), ("Aurangabad", "Chhatrapati Sambhajinagar", "Maharashtra", "West"),
    ("Sanand", "Ahmedabad", "Gujarat", "West"), ("Vadodara", "Vadodara", "Gujarat", "West"),
    ("Rajkot", "Rajkot", "Gujarat", "West"), ("Vapi", "Vapi", "Gujarat", "West"),
    ("Pithampur", "Dhar", "Madhya Pradesh", "Central"), ("Manesar", "Gurugram", "Haryana", "North"),
    ("Faridabad", "Faridabad", "Haryana", "North"), ("Noida", "Gautam Buddha Nagar", "Uttar Pradesh", "North"),
    ("Ludhiana", "Ludhiana", "Punjab", "North"), ("Jaipur", "Jaipur", "Rajasthan", "North"),
    ("Jamshedpur", "Jamshedpur", "Jharkhand", "East"), ("Howrah", "Howrah", "West Bengal", "East"),
    ("Kolkata", "Kolkata", "West Bengal", "East"),
]

# Deterministic and configurable weights for the FREP intelligent match engine.
# This prototype deliberately does not claim machine-learning inference.
MATCH_WEIGHTS = {
    "capability": 0.15, "capacity": 0.15, "availability": 0.12,
    "location": 0.10, "budget": 0.10, "reliability": 0.08,
    "verification": 0.07, "health": 0.06, "quality": 0.04,
    "deadline": 0.05, "logistics": 0.04, "material": 0.04,
}

# Booking states deliberately use display-ready names because the existing
# vanilla-JS client renders the status directly.  State transitions are still
# enforced by the backend rather than trusting the client.
BOOKING_STATES = {
    "Draft", "Requested", "Pending Owner Approval", "Confirmed",
    "Capacity Reserved", "In Progress", "Ready for Delivery", "Completed",
    "Cancelled", "Disputed",
}
TERMINAL_BOOKING_STATES = {"Completed", "Cancelled"}
ACTIVE_RESERVATION_STATUSES = ("held", "reserved")
OWNER_APPROVAL_VALUE_THRESHOLD = 50000
OWNER_APPROVAL_CAPACITY_RATIO = 0.75
MAX_COMPOSE_TEXT_LENGTH = 500
COPILOT_ACTION_TOKEN_TTL_SECONDS = 10 * 60
COPILOT_ACTION_TOKEN_SALT = "frep-copilot-action-v1"
SSE_CONNECTION_MAX_SECONDS = 30

# Analytics coefficients are intentionally visible and returned by the API.
# They make the sustainability card a reproducible prototype estimate rather
# than a fixed marketing number.  These are planning factors, not an audited
# life-cycle assessment.
ANALYTICS_CATEGORIES = (
    "Machinery",
    "Warehouse Space",
    "Testing Equipment",
    "Skilled Operator",
    "Logistics Vehicle",
)
ANALYTICS_TREND_MONTHS = 4
ANALYTICS_MOVING_AVERAGE_MONTHS = 3
CARBON_CAPACITY_CREDIT_KG = {
    "Machinery": 96.0,
    "Warehouse Space": 36.0,
    "Testing Equipment": 48.0,
    "Skilled Operator": 0.0,
    "Logistics Vehicle": 30.0,
}
CARBON_DEFAULT_CAPACITY_CREDIT_KG = 24.0
CARBON_DEFAULT_UTILIZATION_PERCENT = 50.0
CARBON_DEFAULT_TRANSPORT_RATE_INR = 1200.0
CARBON_ASSUMED_TRANSPORT_COST_INR_PER_KM = 30.0
CARBON_TRANSPORT_EMISSIONS_KG_PER_KM = 0.18

DEMO_USERS = (
    {
        "id": "U-BUYER", "username": "buyer", "password": "buyer123",
        "display_name": "Demo Buyer", "role": "buyer", "owner_id": None,
    },
    {
        "id": "U-OWNER", "username": "owner", "password": "owner123",
        "display_name": "Srinivasa Tools", "role": "owner", "owner_id": "O-100",
    },
    {
        "id": "U-ADMIN", "username": "admin", "password": "admin123",
        "display_name": "FREP Admin", "role": "admin", "owner_id": None,
    },
)


def now_iso():
    """Return a sortable, timezone-neutral timestamp for this local demo."""
    return datetime.now().replace(microsecond=0).isoformat()


def today_iso():
    return datetime.now().strftime("%Y-%m-%d")


def as_float(value, default=0.0):
    try:
        if value is None or value == "":
            return float(default)
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def as_int(value, default=0):
    try:
        if value is None or value == "":
            return int(default)
        return int(float(value))
    except (TypeError, ValueError):
        return int(default)


def as_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def row_value(row, key, default=None):
    """Read a value from either sqlite3.Row or a plain dict safely."""
    if row is None:
        return default
    if isinstance(row, sqlite3.Row):
        return row[key] if key in row.keys() and row[key] is not None else default
    return row.get(key, default) if isinstance(row, dict) else default


def load_json_list(value):
    try:
        parsed = json.loads(value) if value else []
        return parsed if isinstance(parsed, list) else []
    except (TypeError, ValueError, json.JSONDecodeError):
        return []


def api_error(code, message, status=400, details=None):
    """A consistent error body without changing the legacy success shapes."""
    body = {"ok": False, "error": {"code": code, "message": message}}
    if details:
        body["error"]["details"] = details
    return jsonify(body), status


class FrepActionError(Exception):
    """Domain validation error shared by legacy and confirmed writes."""

    def __init__(self, code, message, status=400, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details


def copilot_action_serializer():
    """Build a serializer from the active app secret for session-bound drafts."""
    return URLSafeTimedSerializer(
        app.config["SECRET_KEY"],
        salt=COPILOT_ACTION_TOKEN_SALT,
    )


def action_error_response(error):
    return api_error(error.code, error.message, error.status, error.details)


def add_audit_log(conn, entity_type, entity_id, action, actor_type="system", actor_id=None, metadata=None):
    conn.execute(
        """
        INSERT INTO audit_logs (id, entity_type, entity_id, action, actor_type, actor_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            f"AUD-{uuid.uuid4().hex}", entity_type, entity_id, action,
            actor_type or "system", actor_id,
            json.dumps(metadata or {}, sort_keys=True), now_iso(),
        ),
    )


def add_notification(
    conn,
    title,
    detail,
    kind,
    severity="Medium",
    related_type=None,
    related_id=None,
    action=None,
    recipient_user_id=None,
    recipient_role=None,
):
    conn.execute(
        """
        INSERT INTO notifications
        (id, title, detail, kind, created_at, severity, related_entity_type,
         related_entity_id, action_label, is_read, recipient_user_id, recipient_role)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            f"N-{uuid.uuid4().hex}", title, detail, kind, now_iso(), severity,
            related_type, related_id, action, 0, recipient_user_id, recipient_role,
        ),
    )


def parse_datetime_value(value):
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        return datetime.fromisoformat(text).replace(tzinfo=None)
    except ValueError:
        return None


def _analytics_datetime(value):
    """Parse current ISO timestamps and a few unambiguous legacy formats."""
    parsed = parse_datetime_value(value)
    if parsed is not None:
        return parsed
    text = str(value or "").strip()
    if not text:
        return None
    for date_format in (
        "%Y/%m/%d",
        "%d-%m-%Y",
        "%d/%m/%Y",
        "%Y-%m-%d %H:%M:%S",
        "%d %b %Y",
        "%d %B %Y",
    ):
        try:
            return datetime.strptime(text, date_format)
        except ValueError:
            continue
    return None


def _analytics_resource_ids(value):
    """Return unique resource ids without trusting legacy JSON blindly."""
    malformed = False
    if isinstance(value, list):
        decoded = value
    else:
        text = str(value or "").strip()
        if not text:
            return [], True
        try:
            decoded = json.loads(text)
        except (TypeError, ValueError, json.JSONDecodeError):
            # Some pre-JSON prototype databases stored a comma-separated id.
            decoded = [item.strip(" []\"'") for item in re.split(r"[,;]", text)]
            malformed = True
    if isinstance(decoded, (str, int, float)):
        decoded = [decoded]
        malformed = True
    if not isinstance(decoded, list):
        return [], True
    resource_ids = []
    for value in decoded:
        if not isinstance(value, (str, int, float)):
            malformed = True
            continue
        resource_id = str(value).strip()
        if resource_id and resource_id not in resource_ids:
            resource_ids.append(resource_id)
    return resource_ids, malformed


def _analytics_month(year, month, offset=0):
    absolute_month = (year * 12) + (month - 1) + offset
    shifted_year, zero_based_month = divmod(absolute_month, 12)
    return shifted_year, zero_based_month + 1


def _finite_float(value, default=0.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = math.nan
    if math.isfinite(number):
        return number
    try:
        fallback = float(default)
    except (TypeError, ValueError):
        fallback = 0.0
    return fallback if math.isfinite(fallback) else 0.0


def _analytics_utilization(resource):
    """Prefer a recorded percentage, then derive it from capacity inventory."""
    raw_utilization = row_value(resource, "utilization")
    if raw_utilization not in (None, ""):
        percentage = _finite_float(raw_utilization, -1)
        if 0 <= percentage <= 100:
            return percentage / 100.0, "recorded_percentage"

    capacity_default = row_value(resource, "capacity_per_day", 0) or 0
    total = _finite_float(
        row_value(resource, "total_capacity", capacity_default),
        capacity_default,
    )
    available_raw = row_value(resource, "available_capacity")
    if total > 0 and available_raw not in (None, ""):
        available = min(total, max(0.0, _finite_float(available_raw, total)))
        return (total - available) / total, "derived_from_capacity"
    return CARBON_DEFAULT_UTILIZATION_PERCENT / 100.0, "assumed_default"


def _carbon_allocation_estimate(resource):
    """Estimate one booked resource allocation with reproducible coefficients."""
    category = str(row_value(resource, "category", "") or "")
    credit = CARBON_CAPACITY_CREDIT_KG.get(
        category, CARBON_DEFAULT_CAPACITY_CREDIT_KG
    )
    utilization, utilization_source = _analytics_utilization(resource)
    gross_avoided = credit * utilization

    # FREP currently stores a transport rate but not route kilometres on a
    # booking.  Rate / assumed INR-per-km is therefore exposed as a proxy, not
    # presented as measured distance.  Non-physical operator allocations carry
    # neither an equipment credit nor a freight penalty.
    transport_rate_raw = row_value(resource, "transport_rate")
    if transport_rate_raw in (None, ""):
        transport_rate = CARBON_DEFAULT_TRANSPORT_RATE_INR
        transport_source = "assumed_default_rate"
    else:
        transport_rate = max(
            0.0,
            _finite_float(
                transport_rate_raw, CARBON_DEFAULT_TRANSPORT_RATE_INR
            ),
        )
        transport_source = "recorded_rate"
    distance_proxy = (
        transport_rate / CARBON_ASSUMED_TRANSPORT_COST_INR_PER_KM
        if credit > 0
        else 0.0
    )
    transport_emissions = distance_proxy * CARBON_TRANSPORT_EMISSIONS_KG_PER_KM
    return {
        "category": category or "Uncategorized",
        "grossAvoidedKg": gross_avoided,
        "transportEmissionsKg": transport_emissions,
        "netKg": gross_avoided - transport_emissions,
        "utilizationPercent": utilization * 100,
        "utilizationSource": utilization_source,
        "distanceProxyKm": distance_proxy,
        "transportSource": transport_source,
    }


def _carbon_summary(parsed_bookings, resources_by_id, included_statuses):
    """Aggregate estimated impact for the requested normalized statuses."""
    gross_avoided = 0.0
    transport_emissions = 0.0
    utilization_total = 0.0
    allocation_count = 0
    missing_resource_references = 0
    booking_count = 0
    by_category = {}
    utilization_sources = {}
    transport_sources = {}

    for booking in parsed_bookings:
        if booking["status"] not in included_statuses:
            continue
        booking_count += 1
        for resource_id in booking["resourceIds"]:
            resource = resources_by_id.get(resource_id)
            if resource is None:
                missing_resource_references += 1
                continue
            estimate = _carbon_allocation_estimate(resource)
            allocation_count += 1
            gross_avoided += estimate["grossAvoidedKg"]
            transport_emissions += estimate["transportEmissionsKg"]
            utilization_total += estimate["utilizationPercent"]
            utilization_sources[estimate["utilizationSource"]] = (
                utilization_sources.get(estimate["utilizationSource"], 0) + 1
            )
            transport_sources[estimate["transportSource"]] = (
                transport_sources.get(estimate["transportSource"], 0) + 1
            )
            category = estimate["category"]
            category_row = by_category.setdefault(
                category,
                {
                    "category": category,
                    "resourceAllocations": 0,
                    "grossAvoidedKg": 0.0,
                    "transportEmissionsKg": 0.0,
                    "distanceProxyKm": 0.0,
                },
            )
            category_row["resourceAllocations"] += 1
            category_row["grossAvoidedKg"] += estimate["grossAvoidedKg"]
            category_row["transportEmissionsKg"] += estimate[
                "transportEmissionsKg"
            ]
            category_row["distanceProxyKm"] += estimate["distanceProxyKm"]

    category_order = {
        category: index for index, category in enumerate(ANALYTICS_CATEGORIES)
    }
    category_rows = []
    for category_row in sorted(
        by_category.values(),
        key=lambda item: (
            category_order.get(item["category"], len(category_order)),
            item["category"],
        ),
    ):
        category_net = (
            category_row["grossAvoidedKg"]
            - category_row["transportEmissionsKg"]
        )
        category_rows.append(
            {
                **category_row,
                "grossAvoidedKg": round(category_row["grossAvoidedKg"], 2),
                "transportEmissionsKg": round(
                    category_row["transportEmissionsKg"], 2
                ),
                "distanceProxyKm": round(category_row["distanceProxyKm"], 2),
                "netBalanceKg": round(category_net, 2),
            }
        )

    net_balance = gross_avoided - transport_emissions
    return {
        "bookingCount": booking_count,
        "resourceAllocations": allocation_count,
        "grossAvoidedKg": round(gross_avoided, 2),
        "transportEmissionsKg": round(transport_emissions, 2),
        "netBalanceKg": round(net_balance, 2),
        "netSavedKg": round(max(0.0, net_balance), 1),
        "averageUtilizationPercent": round(
            utilization_total / allocation_count, 2
        ) if allocation_count else 0.0,
        "missingResourceReferences": missing_resource_references,
        "utilizationSources": utilization_sources,
        "transportSources": transport_sources,
        "byCategory": category_rows,
    }


def is_date_only(value):
    text = str(value or "").strip()
    return len(text) == 10 and text[4:5] == "-" and text[7:8] == "-"


def iso_timestamp(value):
    return value.replace(microsecond=0).isoformat()


def booking_window(payload, item=None):
    """Normalize flexible booking date inputs into one half-open ISO window."""
    item = item or {}

    def pick(*keys):
        for key in keys:
            value = item.get(key) if key in item else payload.get(key)
            if value not in (None, ""):
                return value
        return None

    start_raw = pick("startAt", "startDate", "bookingStart", "availableFrom")
    end_raw = pick("endAt", "endDate", "bookingEnd", "availableUntil")
    duration = as_float(pick("durationDays", "duration", "days"), 1)
    if duration <= 0:
        return None, None, "Booking duration must be greater than zero."

    start = parse_datetime_value(start_raw) or datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    end = parse_datetime_value(end_raw)
    if end is None:
        end = start + timedelta(days=duration)
    elif is_date_only(end_raw):
        # Dates in a form conventionally represent the full final day.
        end = end + timedelta(days=1)
    if end <= start:
        return None, None, "Booking end must be after its start."
    return iso_timestamp(start), iso_timestamp(end), None


def resource_capacity_limits(resource):
    """Return a stable capacity baseline independent of active reservations."""
    category = row_value(resource, "category", "")
    category_default = get_capacity({"category": category})
    total = as_float(row_value(resource, "total_capacity"), row_value(resource, "capacity_per_day", category_default))
    if total <= 0:
        total = float(category_default)
    baseline = as_float(
        row_value(resource, "allocatable_capacity"),
        row_value(resource, "available_capacity", total),
    )
    baseline = min(total, max(0.0, baseline))
    minimum = max(0.0, as_float(row_value(resource, "minimum_booking"), 1))
    maximum = as_float(row_value(resource, "maximum_booking"), baseline)
    maximum = min(baseline, maximum if maximum > 0 else baseline)
    return {
        "total": total,
        "baseline": baseline,
        "minimum": minimum,
        "maximum": maximum,
        "unit": row_value(resource, "capacity_unit", "units/day") or "units/day",
    }


def resource_window_is_available(resource, start_at, end_at):
    start = parse_datetime_value(start_at)
    end = parse_datetime_value(end_at)
    available_from = parse_datetime_value(row_value(resource, "available_from"))
    available_until = parse_datetime_value(row_value(resource, "available_until"))
    if available_from and start and start < available_from:
        return False
    if available_until and end:
        # A date-only availability end is inclusive, just like booking end dates.
        if is_date_only(row_value(resource, "available_until")):
            available_until += timedelta(days=1)
        if end > available_until:
            return False
    return True


def reserved_capacity_for_window(conn, resource_id, start_at, end_at, exclude_booking_id=None):
    sql = """
        SELECT COALESCE(SUM(reserved_capacity), 0)
        FROM capacity_reservations
        WHERE resource_id = ?
          AND LOWER(status) IN ('held', 'reserved')
          AND start_at < ? AND end_at > ?
    """
    params = [resource_id, end_at, start_at]
    if exclude_booking_id:
        sql += " AND booking_id != ?"
        params.append(exclude_booking_id)
    return as_float(conn.execute(sql, params).fetchone()[0], 0)


def refresh_resource_capacity(conn, resource_id):
    """Recalculate free capacity from the highest overlapping active reservation.

    `allocatable_capacity` is the owner-advertised baseline.  This avoids the
    common bug where two non-overlapping future bookings are rejected simply
    because all future holds were subtracted from one global counter.
    """
    resource = conn.execute("SELECT * FROM resources WHERE id = ?", (resource_id,)).fetchone()
    if not resource:
        return None
    limits = resource_capacity_limits(resource)
    reservations = conn.execute(
        """
        SELECT reserved_capacity, start_at, end_at FROM capacity_reservations
        WHERE resource_id = ? AND LOWER(status) IN ('held', 'reserved')
        """,
        (resource_id,),
    ).fetchall()
    events = []
    for reservation in reservations:
        start = parse_datetime_value(reservation["start_at"])
        end = parse_datetime_value(reservation["end_at"])
        capacity = max(0.0, as_float(reservation["reserved_capacity"], 0))
        if not start or not end or end <= start or capacity <= 0:
            continue
        events.append((start, capacity))
        events.append((end, -capacity))
    # Ending reservations are processed before starts at the same instant so
    # adjacent bookings do not count as overlapping.
    events.sort(key=lambda item: (item[0], 0 if item[1] < 0 else 1))
    running = 0.0
    peak = 0.0
    for _, change in events:
        running += change
        peak = max(peak, running)
    free_capacity = max(0.0, limits["baseline"] - peak)
    manual_available = as_bool(row_value(resource, "manual_availability"), as_bool(resource["availability"], True))
    effective_available = 1 if manual_available and free_capacity > 0 else 0
    utilization = round(((limits["total"] - free_capacity) / limits["total"]) * 100, 2) if limits["total"] else 0
    conn.execute(
        """
        UPDATE resources
        SET available_capacity = ?, availability = ?, utilization = ?
        WHERE id = ?
        """,
        (round(free_capacity, 4), effective_available, utilization, resource_id),
    )
    return {
        "resourceId": resource_id,
        "availableCapacity": round(free_capacity, 4),
        "totalCapacity": limits["total"],
        "capacityUnit": limits["unit"],
        "reservedCapacity": round(peak, 4),
        "availability": bool(effective_available),
    }


def release_booking_reservations(conn, booking_id, reason, resource_id=None):
    """Release active holds atomically and refresh each affected resource."""
    sql = """
        SELECT DISTINCT resource_id FROM capacity_reservations
        WHERE booking_id = ? AND LOWER(status) IN ('held', 'reserved')
    """
    params = [booking_id]
    if resource_id:
        sql += " AND resource_id = ?"
        params.append(resource_id)
    resource_ids = [row["resource_id"] for row in conn.execute(sql, params).fetchall()]
    update_sql = """
        UPDATE capacity_reservations
        SET status = 'released', released_at = ?, release_reason = ?
        WHERE booking_id = ? AND LOWER(status) IN ('held', 'reserved')
    """
    update_params = [now_iso(), reason, booking_id]
    if resource_id:
        update_sql += " AND resource_id = ?"
        update_params.append(resource_id)
    conn.execute(update_sql, update_params)
    summaries = [refresh_resource_capacity(conn, item_id) for item_id in resource_ids]
    return [summary for summary in summaries if summary]


def normalize_booking_state(value):
    key = " ".join(str(value or "").replace("_", " ").replace("-", " ").split()).lower()
    aliases = {
        "draft": "Draft", "requested": "Requested", "pending owner approval": "Pending Owner Approval",
        "pending": "Pending Owner Approval", "confirmed": "Confirmed",
        "capacity reserved": "Capacity Reserved", "reserved": "Capacity Reserved",
        "in progress": "In Progress", "inprogress": "In Progress",
        "ready for delivery": "Ready for Delivery", "ready": "Ready for Delivery",
        "completed": "Completed", "complete": "Completed", "cancelled": "Cancelled",
        "canceled": "Cancelled", "disputed": "Disputed",
    }
    return aliases.get(key)


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def serialize_user(row):
    if not row:
        return None
    return {
        "id": row_value(row, "id"),
        "username": row_value(row, "username"),
        "name": row_value(row, "display_name"),
        "role": row_value(row, "role"),
        "ownerId": row_value(row, "owner_id"),
    }


def current_user():
    """Resolve the signed session to a live user record."""
    if hasattr(g, "frep_user"):
        return g.frep_user
    user_id = session.get("user_id")
    if not user_id:
        g.frep_user = None
        return None
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, username, display_name, role, owner_id FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        session.clear()
        g.frep_user = None
        return None
    g.frep_user = serialize_user(row)
    return g.frep_user


def require_roles(*allowed_roles):
    """Require an authenticated session and one of the explicit app roles."""
    allowed = set(allowed_roles)

    def decorator(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            user = current_user()
            if not user:
                return api_error("authentication_required", "Please sign in to continue.", 401)
            if user["role"] not in allowed:
                return api_error(
                    "forbidden",
                    f"This action requires one of these roles: {', '.join(sorted(allowed))}.",
                    403,
                )
            return view(*args, **kwargs)

        return wrapped

    return decorator


def ensure_column(conn, table, column_def):
    try:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column_def}")
    except sqlite3.OperationalError:
        pass


def infer_capabilities(category, tags, name="", description=""):
    capabilities = set()
    normalized_text = " ".join(
        [str(category), str(name), str(description), *[str(tag) for tag in (tags or [])]]
    ).lower()

    def contains_any(terms):
        return any(
            re.search(rf"(?<!\w){re.escape(term)}(?!\w)", normalized_text, re.UNICODE)
            for term in terms
        )

    if category == "Machinery":
        capabilities.add("Machinery")
    if category == "Logistics Vehicle":
        capabilities.add("Logistics")
    if category == "Testing Equipment":
        capabilities.add("Quality Inspection")
    if category == "Skilled Operator":
        capabilities.add("Skilled Operator")
    if category == "Warehouse Space":
        capabilities.add("Storage")
    if contains_any(["cnc", "milling", "machining", "precision", "turning", "lathe", "vmc"]):
        capabilities.add("CNC Machining")
    if contains_any(["coating", "finishing", "powder", "polishing", "anodizing"]):
        capabilities.add("Surface Finishing")
    if contains_any(["inspection", "inspect", "cmm", "lab", "laboratory", "quality", "testing"]):
        capabilities.add("Quality Inspection")
    if contains_any(["operator", "technician", "welder"]):
        capabilities.add("Skilled Operator")
    if contains_any(["forklift", "truck", "transport", "logistics"]):
        capabilities.add("Logistics")
    capabilities.update(infer_capabilities_from_text(normalized_text))
    if not capabilities:
        capabilities.add(category)
    return sorted(capabilities)


def parse_production_requirement(payload):
    processes = [item.strip() for item in payload.get("processes", "").split(",") if item.strip()]
    capabilities = set()
    for process in processes:
        lower = process.lower()
        if any(token in lower for token in ["cnc", "lathe", "mill", "machining", "turning", "vmc"]):
            capabilities.add("CNC Machining")
        if any(token in lower for token in ["finish", "coating", "paint", "surface"]):
            capabilities.add("Surface Finishing")
        if any(token in lower for token in ["inspect", "quality", "cmm", "testing", "lab"]):
            capabilities.add("Quality Inspection")
        if any(token in lower for token in ["operator", "skilled", "manpower"]):
            capabilities.add("Skilled Operator")
        if any(token in lower for token in ["truck", "logistic", "transport", "forklift"]):
            capabilities.add("Logistics")
        if any(token in lower for token in ["warehouse", "storage"]):
            capabilities.add("Storage")
    if not capabilities:
        if payload.get("material"):
            capabilities.add("CNC Machining")
        else:
            capabilities.update(["CNC Machining", "Skilled Operator", "Quality Inspection", "Logistics"])
    return sorted(capabilities)


def estimate_transport_cost(resource, cluster):
    base = resource.get("transport_rate") if resource.get("transport_rate") is not None else 1200
    if resource.get("cluster") == cluster or not cluster:
        return int(base)
    return int(base * 1.35)


def get_capacity(resource):
    if resource.get("availableCapacity") is not None:
        return resource["availableCapacity"]
    if resource.get("capacityPerDay"):
        return resource["capacityPerDay"]
    category = resource.get("category", "")
    if category == "Machinery":
        return 120
    if category == "Testing Equipment":
        return 180
    if category == "Skilled Operator":
        return 260
    if category == "Logistics Vehicle":
        return 500
    if category == "Warehouse Space":
        return 1000
    return 100


def score_resource(resource, capability, query):
    requested_capability = str(capability or "").strip()
    resource_capabilities = [str(item) for item in resource.get("capabilities", [])]
    normalized_capabilities = {item.lower() for item in resource_capabilities}
    if not requested_capability:
        capability_match = 0.7
    elif requested_capability.lower() in normalized_capabilities:
        capability_match = 1.0
    else:
        requested_tokens = set(requested_capability.lower().replace("&", " ").split())
        resource_tokens = set(" ".join(resource_capabilities).lower().replace("&", " ").split())
        capability_match = 0.65 if requested_tokens & resource_tokens else 0.35
    requested_cluster = str(query.get("cluster") or "").strip()
    location_match = 1.0 if not requested_cluster or resource.get("cluster", "").lower() == requested_cluster.lower() else 0.75
    budget_share = query.get("budget_per_resource")
    if budget_share is None:
        budget_share = query.get("budget", 1) / max(1, len(query.get("capabilities", [])))
    cost_efficiency = 1.0 if resource.get("pricePerDay", 0) <= budget_share else max(0.35, 1 - (resource.get("pricePerDay", 0) - budget_share) / max(1, budget_share))
    availability = 1.0 if resource.get("availability") else 0.1
    verification = 1.0 if resource.get("verified") else 0.4
    rating = min(1, resource.get("rating", 4.0) / 5.0)
    required_capacity = max(1, query.get("quantity", 1) / max(1, query.get("deadline_days", 1)))
    capacity = min(1, get_capacity(resource) / required_capacity)
    health = min(1, resource.get("healthScore", 75) / 100)
    reliability = min(1, resource.get("trustScore", rating * 100) / 100)
    material = 1.0 if not query.get("material") or query["material"].lower() in " ".join(resource.get("tags", [])).lower() else 0.75
    transport_cost = estimate_transport_cost(resource, query.get("cluster"))
    transport = 1.0 if transport_cost <= 1500 else max(0.35, 1 - (transport_cost - 1500) / 5000)
    deadline_days = query.get("deadline_days", 7)
    deadline = 1.0 if deadline_days >= 3 else 0.8
    factor_scores = {
        "capability": capability_match,
        "capacity": capacity,
        "availability": availability,
        "location": location_match,
        "budget": cost_efficiency,
        "reliability": reliability,
        "verification": verification,
        "health": health,
        "quality": rating,
        "deadline": deadline,
        "logistics": transport,
        "material": material,
    }
    labels = {
        "capability": "Capability fit", "capacity": "Capacity fit",
        "availability": "Availability", "location": "Cluster proximity",
        "budget": "Price fit", "reliability": "Reliability",
        "verification": "Verification", "health": "Equipment health",
        "quality": "Rating", "deadline": "Deadline fit",
        "logistics": "Logistics", "material": "Material fit",
    }
    contributions = {
        factor: round(factor_scores[factor] * weight * 100, 2)
        for factor, weight in MATCH_WEIGHTS.items()
    }
    weights = {factor: round(weight * 100, 2) for factor, weight in MATCH_WEIGHTS.items()}
    drivers = sorted(
        (
            {
                "factor": factor,
                "label": labels[factor],
                "score": round(factor_scores[factor] * 100),
                "weight": weights[factor],
                "contribution": contributions[factor],
            }
            for factor in MATCH_WEIGHTS
        ),
        key=lambda item: (-item["contribution"], item["factor"]),
    )[:3]
    why_parts = []
    if capability_match >= 0.95 and requested_capability:
        why_parts.append(f"{requested_capability} capability ({weights['capability']:g}%)")
    if availability >= 0.95:
        why_parts.append(f"available now ({weights['availability']:g}%)")
    if requested_cluster and location_match >= 0.95:
        why_parts.append(f"in {resource.get('cluster')} ({weights['location']:g}%)")
    if query.get("budget_specified") and cost_efficiency >= 0.95:
        why_parts.append(f"price fits budget ({weights['budget']:g}%)")
    if resource.get("verified"):
        why_parts.append(f"verified ({weights['verification']:g}%)")
    if len(why_parts) < 3 and rating >= 0.85:
        why_parts.append(f"{resource.get('rating', 0):g}/5 rating ({weights['quality']:g}%)")
    if not why_parts:
        why_parts = [f"{item['label'].lower()} contributes {item['contribution']:g} points" for item in drivers]
    why = "Strong match: " + ", ".join(why_parts[:3]) + "."
    score = sum(contributions.values())
    return {
        "capabilityCompatibility": round(capability_match * 100),
        "capacityAvailable": round(capacity * 100),
        "locationProximity": round(location_match * 100),
        "costEfficiency": round(cost_efficiency * 100),
        "availability": round(availability * 100),
        "verification": round(verification * 100),
        "rating": round(rating * 100),
        "reliability": round(reliability * 100),
        "health": round(health * 100),
        "materialCompatibility": round(material * 100),
        "transportation": round(transport * 100),
        "deadlineCompatibility": round(deadline * 100),
        "score": round(score),
        "transportCost": transport_cost,
        "weights": weights,
        "contributions": contributions,
        "drivers": drivers,
        "why": why,
    }


def _requested_capabilities(payload):
    """Derive the buyer's requested capabilities, never from a candidate."""
    explicit = payload.get("capabilities")
    if isinstance(explicit, str):
        explicit = [item.strip() for item in explicit.split(",") if item.strip()]
    elif not isinstance(explicit, list):
        explicit = []
    text = " ".join(
        str(payload.get(key) or "")
        for key in ("search", "resourceType", "material", "processes")
    )
    inferred = infer_capabilities_from_text(text)
    category = str(payload.get("resourceType") or "").strip()
    category_capabilities = (
        infer_capabilities(category, [])
        if category and not explicit and not inferred
        else []
    )
    ordered = []
    for item in [*explicit, *inferred, *category_capabilities]:
        if item and item not in ordered:
            ordered.append(item)
    return ordered


def _blended_match_explanation(breakdown, semantic_score):
    """Blend TF-IDF into factor contributions while keeping the math visible."""
    factor_scale = 0.82
    semantic_weight = 18.0
    weights = {
        factor: round(weight * factor_scale, 2)
        for factor, weight in breakdown["weights"].items()
    }
    weights["semantic"] = semantic_weight
    contributions = {
        factor: round(value * factor_scale, 2)
        for factor, value in breakdown["contributions"].items()
    }
    contributions["semantic"] = round(semantic_score * semantic_weight / 100, 2)
    labels = {item["factor"]: item["label"] for item in breakdown["drivers"]}
    labels.update({
        "capability": "Capability fit", "capacity": "Capacity fit",
        "availability": "Availability", "location": "Cluster proximity",
        "budget": "Price fit", "reliability": "Reliability",
        "verification": "Verification", "health": "Equipment health",
        "quality": "Rating", "deadline": "Deadline fit",
        "logistics": "Logistics", "material": "Material fit",
        "semantic": "Text similarity",
    })
    score_lookup = {
        "capability": breakdown["capabilityCompatibility"],
        "capacity": breakdown["capacityAvailable"],
        "availability": breakdown["availability"],
        "location": breakdown["locationProximity"],
        "budget": breakdown["costEfficiency"],
        "reliability": breakdown["reliability"],
        "verification": breakdown["verification"],
        "health": breakdown["health"],
        "quality": breakdown["rating"],
        "deadline": breakdown["deadlineCompatibility"],
        "logistics": breakdown["transportation"],
        "material": breakdown["materialCompatibility"],
        "semantic": semantic_score,
    }
    drivers = sorted(
        (
            {
                "factor": factor,
                "label": labels[factor],
                "score": score_lookup[factor],
                "weight": weight,
                "contribution": contributions[factor],
            }
            for factor, weight in weights.items()
        ),
        key=lambda item: (-item["contribution"], item["factor"]),
    )[:3]
    why = breakdown["why"]
    for factor in ("capability", "availability", "location", "budget", "verification", "quality"):
        original = f"({breakdown['weights'][factor]:g}%)"
        blended = f"({weights[factor]:g}%)"
        why = why.replace(original, blended, 1)
    return {
        "score": min(100, round(sum(contributions.values()))),
        "why": why,
        "drivers": drivers,
        "weights": weights,
        "contributions": contributions,
    }


def rank_resource_matches(payload, resources, limit=40, reference_time=None):
    """Pure, shared catalogue ranking used by search and Compose.

    It receives the catalogue as data and performs no database access or
    writes.  The optional reference time makes deadline scoring deterministic
    in tests.
    """
    payload = dict(payload or {})
    catalogue = list(resources or [])
    reference_time = reference_time or datetime.now()
    search = str(payload.get("search") or "").strip()
    resource_type = str(payload.get("resourceType") or "").strip()
    cluster = str(payload.get("cluster") or "").strip()
    query_text = " ".join(value for value in (search, resource_type, cluster) if value)
    semantic = {
        item["resource"]["id"]: item["score"]
        for item in semantic_rank(query_text or "resource", catalogue, limit=max(50, len(catalogue)))
    }
    requested_capabilities = _requested_capabilities(payload)
    budget_specified = payload.get("budget") not in (None, "")
    query = {
        "cluster": cluster,
        "budget": as_int(payload.get("budget"), 999999),
        "budget_per_resource": as_int(payload.get("budget"), 999999),
        "budget_specified": budget_specified,
        "deadline_days": 7,
        "capabilities": requested_capabilities or [""],
        "quantity": max(1, as_int(payload.get("quantity"), 1)),
        "material": str(payload.get("material") or ""),
    }
    deadline = payload.get("deadline")
    if deadline not in (None, ""):
        if isinstance(deadline, (int, float)) or str(deadline).strip().isdigit():
            query["deadline_days"] = max(1, as_int(deadline, 7))
        else:
            try:
                query["deadline_days"] = max(
                    1,
                    (datetime.fromisoformat(str(deadline)[:10]) - reference_time).days,
                )
            except ValueError:
                query["deadline_days"] = 7

    scored = []
    for resource in catalogue:
        resource_capabilities = {
            str(item).lower() for item in resource.get("capabilities", [])
        }
        capability_exact = any(
            capability.lower() in resource_capabilities
            for capability in requested_capabilities
        )
        if requested_capabilities and not capability_exact:
            continue
        if as_bool(payload.get("verifiedOnly")) and not resource.get("verified"):
            continue
        if as_bool(payload.get("availableOnly")) and not resource.get("availability"):
            continue
        if resource_type and (
            resource.get("category") != resource_type
            and resource_type.lower() not in str(resource.get("name") or "").lower()
            and not capability_exact
        ):
            continue
        if cluster and cluster.lower() not in str(resource.get("cluster") or "").lower():
            continue
        if budget_specified and resource.get("pricePerDay", 0) > as_int(payload.get("budget"), 10**9):
            continue

        searchable = " ".join((
            str(resource.get("name") or ""), str(resource.get("category") or ""),
            str(resource.get("cluster") or ""), str(resource.get("description") or ""),
            " ".join(resource.get("tags") or []),
            " ".join(resource.get("capabilities") or []),
        )).lower()
        if search and search.lower() not in searchable:
            if semantic.get(resource["id"], 0) < 0.08 and not capability_exact:
                continue

        if requested_capabilities:
            requested = max(
                requested_capabilities,
                key=lambda item: 1 if item.lower() in resource_capabilities else 0,
            )
        else:
            requested = ""
        breakdown = score_resource(resource, requested, query)
        semantic_score = round(semantic.get(resource["id"], 0) * 100)
        breakdown["semantic"] = semantic_score
        explanation = _blended_match_explanation(breakdown, semantic_score)
        breakdown["blendedScore"] = explanation["score"]
        scored.append({
            **resource,
            "match": {
                "score": explanation["score"],
                "breakdown": breakdown,
                "why": explanation["why"],
                "drivers": explanation["drivers"],
                "weights": explanation["weights"],
                "contributions": explanation["contributions"],
            },
        })

    sort = str(payload.get("sort") or "score")
    if sort == "price":
        scored.sort(key=lambda item: item["pricePerDay"])
    elif sort == "rating":
        scored.sort(key=lambda item: item.get("rating") or 0, reverse=True)
    else:
        scored.sort(key=lambda item: item["match"]["score"], reverse=True)
    return scored[:max(0, int(limit))]


def build_resource_chain(resources, capabilities, query):
    chain = []
    used_ids = set()
    resources_sorted = sorted(resources, key=lambda r: (not r.get("availability"), -r.get("verified", 0), -r.get("rating", 0), r.get("pricePerDay", 999999)))
    for capability in capabilities:
        candidates = [r for r in resources_sorted if capability in r.get("capabilities", [])]
        if not candidates:
            candidates = [r for r in resources_sorted if capability.lower() in " ".join([r.get("name", ""), r.get("description", ""), " ".join(r.get("tags", []))]).lower()]
        best = None
        best_score = -1
        for resource in candidates:
            if resource["id"] in used_ids:
                continue
            breakdown = score_resource(resource, capability, query)
            if breakdown["score"] > best_score:
                best_score = breakdown["score"]
                best = (resource, breakdown)
        if best:
            selected, breakdown = best
            used_ids.add(selected["id"])
            chain.append({
                "capability": capability,
                "resource": selected,
                "scoreBreakdown": breakdown,
                "why": breakdown["why"],
                "drivers": breakdown["drivers"],
                "weights": breakdown["weights"],
                "contributions": breakdown["contributions"],
                "estimatedTransport": breakdown["transportCost"],
            })
    return chain


def compute_plan_options(chain, query):
    if not chain:
        return []
    base_cost = sum(item["resource"]["pricePerDay"] for item in chain)
    transport_cost = sum(item["estimatedTransport"] for item in chain)
    capacity = sum(get_capacity(item["resource"]) for item in chain)
    quantity = query.get("quantity", 1)
    estimated_days = max(1, round(quantity / max(1, capacity), 1))
    total_effective = base_cost + transport_cost
    options = [
        {
            "label": "Optimal bundle",
            "resources": chain,
            "estimatedTotal": total_effective,
            "estimatedDuration": estimated_days,
            "estimatedTransport": transport_cost,
            "risk": "LOW",
            "score": int(sum(item["scoreBreakdown"]["score"] for item in chain) / len(chain)),
        },
        {
            "label": "Cheaper option",
            "resources": sorted(chain, key=lambda item: item["resource"]["pricePerDay"]),
            "estimatedTotal": max(0, int(total_effective * 0.89)),
            "estimatedDuration": round(estimated_days * 1.15, 1),
            "estimatedTransport": int(transport_cost * 0.95),
            "risk": "MEDIUM",
            "score": max(0, int(sum(item["scoreBreakdown"]["score"] for item in chain) / len(chain) - 6)),
        },
        {
            "label": "Fastest option",
            "resources": sorted(chain, key=lambda item: -get_capacity(item["resource"])),
            "estimatedTotal": int(total_effective * 1.12),
            "estimatedDuration": max(1, round(estimated_days * 0.74, 1)),
            "estimatedTransport": int(transport_cost * 1.1),
            "risk": "LOW",
            "score": min(100, int(sum(item["scoreBreakdown"]["score"] for item in chain) / len(chain) + 2)),
        },
    ]
    return options


def build_decision_analysis(frep_option, requirements):
    """Transparent demo estimates; assumptions are deliberately configurable."""
    if not frep_option:
        return []
    frep_cost = frep_option["estimatedTotal"]
    frep_days = frep_option["estimatedDuration"]
    capex = max(250000, requirements["quantity"] * 350)
    outsource_cost = int(frep_cost * 1.28)
    return [
        {"option": "Buy capability", "estimatedCost": capex, "estimatedDays": 30, "assumption": "Demo CAPEX estimate; not a market quote."},
        {"option": "Conventional outsource", "estimatedCost": outsource_cost, "estimatedDays": round(frep_days * 1.45, 1), "assumption": "Demo benchmark: 28% above shared-resource estimate."},
        {"option": "FREP share", "estimatedCost": frep_cost, "estimatedDays": frep_days, "assumption": "Estimated from selected FREP resources and transport."},
    ]


def serialize_resource_row(row):
    tags = json.loads(row["tags"]) if row["tags"] else []
    capabilities = json.loads(row["capabilities"]) if row["capabilities"] else infer_capabilities(
        row["category"], tags, row["name"], row["description"]
    )
    return {
        "id": row["id"],
        "name": row["name"],
        "category": row["category"],
        "cluster": row["cluster"],
        "pricePerDay": row["price_per_day"],
        "verified": bool(row["verified"]),
        "rating": row["rating"],
        "availability": bool(row["availability"]),
        "ownerId": row["owner_id"],
        "ownerName": row["owner_name"],
        "description": row["description"],
        "tags": tags,
        "capabilities": capabilities,
        "totalCapacity": row["total_capacity"] if row["total_capacity"] is not None else get_capacity({"category": row["category"]}),
        "availableCapacity": row["available_capacity"] if row["available_capacity"] is not None else get_capacity({"category": row["category"]}),
        "capacityUnit": row["capacity_unit"] or "units/day",
        "healthScore": row["health_score"] if row["health_score"] is not None else 80,
        "trustScore": row["trust_score"] if row["trust_score"] is not None else round(row["rating"] * 20),
        "transport_rate": row["transport_rate"] if row["transport_rate"] is not None else 1200,
        "capacityPerDay": row["capacity_per_day"] if row["capacity_per_day"] is not None else 0,
    }


def load_catalog(conn=None):
    owns_connection = conn is None
    if owns_connection:
        conn = get_db()
    rows = conn.execute("SELECT * FROM resources ORDER BY created_at DESC").fetchall()
    items = [serialize_resource_row(row) for row in rows]
    if owns_connection:
        conn.close()
    return items


def load_cluster_directory(conn=None):
    owns_connection = conn is None
    if owns_connection:
        conn = get_db()
    clusters = [dict(row) for row in conn.execute(
        "SELECT name, city, state, region FROM industrial_clusters ORDER BY region, state, city, name"
    ).fetchall()]
    if owns_connection:
        conn.close()
    return clusters


def format_resource(resource):
    return {
        "id": resource["id"],
        "name": resource["name"],
        "category": resource["category"],
        "cluster": resource["cluster"],
        "pricePerDay": resource["pricePerDay"],
        "verified": resource["verified"],
        "rating": resource["rating"],
        "availability": resource["availability"],
        "ownerName": resource["ownerName"],
        "description": resource["description"],
        "capabilities": resource.get("capabilities", []),
    }


def create_resource_record(conn, payload, user):
    """Insert one owner-scoped, unverified listing inside the caller's transaction."""
    if not user.get("ownerId"):
        raise FrepActionError(
            "owner_profile_required",
            "This owner account is not linked to an MSME owner profile.",
            409,
        )
    resource_id = str(payload.get("id") or f"R-{uuid.uuid4().hex[:12].upper()}").strip()
    if not resource_id or len(resource_id) > 80:
        raise FrepActionError("invalid_resource_id", "Resource id is invalid.", 400)
    try:
        price_per_day = int(payload.get("pricePerDay", 0))
    except (TypeError, ValueError):
        raise FrepActionError("invalid_price", "pricePerDay must be an integer.", 400)
    if price_per_day < 0:
        raise FrepActionError("invalid_price", "pricePerDay cannot be negative.", 400)
    tags = payload.get("tags", ["new"])
    if not isinstance(tags, list):
        raise FrepActionError("invalid_tags", "tags must be an array.", 400)
    tags = [str(item).strip()[:50] for item in tags[:20] if str(item).strip()]
    if not tags:
        tags = ["new"]
    name = str(payload.get("name") or "New listing").strip()[:120]
    category = str(payload.get("category") or "Machinery").strip()[:80]
    cluster = str(payload.get("cluster") or "Peenya").strip()[:100]
    description = str(
        payload.get("description") or "New listing waiting verification."
    ).strip()[:1000]
    capabilities = infer_capabilities(category, tags, name, description)
    try:
        conn.execute(
            """
            INSERT INTO resources
            (id, name, category, cluster, price_per_day, verified, rating,
             availability, owner_id, owner_name, description, tags,
             capabilities, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                resource_id, name, category, cluster, price_per_day, 0, 4.0,
                1 if as_bool(payload.get("availability"), True) else 0,
                user["ownerId"], user["name"], description,
                json.dumps(tags), json.dumps(capabilities), now_iso(),
            ),
        )
    except sqlite3.IntegrityError as exc:
        raise FrepActionError(
            "resource_exists", "A resource with that id already exists.", 409
        ) from exc
    add_notification(
        conn,
        "Verification pending",
        f"New listing {name} requires admin verification.",
        "verification",
        severity="High",
        related_type="resource",
        related_id=resource_id,
        action="Review listing",
        recipient_role="admin",
    )
    add_audit_log(
        conn,
        "resource",
        resource_id,
        "listing_created",
        actor_type="owner",
        actor_id=user["id"],
        metadata={"source": payload.get("source") or "api", "verified": False},
    )
    return resource_id


def create_booking_record(conn, payload, user):
    """Validate and reserve a verified bundle inside the caller's transaction."""
    resource_ids = payload.get("resourceIds", [])
    if not isinstance(resource_ids, list) or not resource_ids:
        raise FrepActionError(
            "invalid_resources", "resourceIds must be a non-empty array.", 400
        )
    resource_ids = list(
        dict.fromkeys(str(item).strip() for item in resource_ids if str(item).strip())
    )
    if not resource_ids:
        raise FrepActionError(
            "invalid_resources", "resourceIds must contain resource ids.", 400
        )
    if len(resource_ids) > 10:
        raise FrepActionError(
            "too_many_resources", "A booking bundle is limited to 10 resources.", 400
        )

    total = 0
    owner_ids = set()
    for resource_id in resource_ids:
        row = conn.execute(
            """
            SELECT id, name, owner_id, price_per_day, verified, availability
            FROM resources WHERE id = ?
            """,
            (resource_id,),
        ).fetchone()
        if not row:
            raise FrepActionError(
                "resource_not_found", f"Resource {resource_id} was not found.", 404
            )
        if not row["verified"]:
            raise FrepActionError(
                "resource_unverified",
                f"Resource {resource_id} must be verified before booking.",
                409,
            )
        if not row["availability"]:
            raise FrepActionError(
                "resource_unavailable",
                f"Resource {resource_id} is no longer available.",
                409,
            )
        total += row["price_per_day"]
        owner_ids.add(row["owner_id"])
        updated = conn.execute(
            """
            UPDATE resources SET availability = 0
            WHERE id = ? AND verified = 1 AND availability = 1
            """,
            (resource_id,),
        )
        if updated.rowcount != 1:
            raise FrepActionError(
                "resource_unavailable",
                f"Resource {resource_id} is no longer available.",
                409,
            )

    booking_id = str(payload.get("id") or f"B-{uuid.uuid4().hex[:12].upper()}").strip()
    note = str(payload.get("note") or "Booked through FREP").strip()[:500]
    try:
        conn.execute(
            """
            INSERT INTO bookings
            (id, buyer, status, total, created_at, rating, resources_json, note, buyer_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                booking_id, user["name"], "In Progress", total, now_iso(), None,
                json.dumps(resource_ids), note, user["id"],
            ),
        )
    except sqlite3.IntegrityError as exc:
        raise FrepActionError(
            "booking_exists", "A booking with that id already exists.", 409
        ) from exc
    add_notification(
        conn,
        "Booking received",
        f"{user['name']} booked {len(resource_ids)} resource(s).",
        "booking",
        severity="High",
        related_type="booking",
        related_id=booking_id,
        action="View booking",
    )
    add_notification(
        conn,
        "Resource availability changed",
        f"{len(resource_ids)} resource(s) are now reserved by booking {booking_id}.",
        "availability",
        related_type="booking",
        related_id=booking_id,
    )
    add_audit_log(
        conn,
        "booking",
        booking_id,
        "booking_created",
        actor_type="buyer",
        actor_id=user["id"],
        metadata={
            "source": payload.get("source") or "api",
            "resourceIds": resource_ids,
            "ownerIds": sorted(owner_ids),
        },
    )
    return {"id": booking_id, "resourceIds": resource_ids, "total": total}


def init_db():
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS resources (
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
            created_at TEXT NOT NULL,
            capabilities TEXT,
            capacity_per_day INTEGER,
            utilization REAL,
            operating_hours INTEGER,
            last_maintenance TEXT,
            next_maintenance TEXT,
            health_score REAL,
            passport_id TEXT,
            transport_rate REAL,
            trust_score REAL
        );

        CREATE TABLE IF NOT EXISTS bookings (
            id TEXT PRIMARY KEY,
            buyer TEXT NOT NULL,
            status TEXT NOT NULL,
            total INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            rating INTEGER,
            resources_json TEXT NOT NULL,
            note TEXT
        );

        CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            detail TEXT NOT NULL,
            kind TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS production_requests (
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

        CREATE TABLE IF NOT EXISTS industrial_clusters (
            name TEXT PRIMARY KEY,
            city TEXT NOT NULL,
            state TEXT NOT NULL,
            region TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL,
            owner_id TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS copilot_confirmations (
            proposal_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            action TEXT NOT NULL,
            result_id TEXT NOT NULL,
            confirmed_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL,
            actor_type TEXT NOT NULL,
            actor_id TEXT,
            metadata_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )
    ensure_column(conn, "resources", "capabilities TEXT")
    ensure_column(conn, "resources", "capacity_per_day INTEGER")
    ensure_column(conn, "resources", "utilization REAL")
    ensure_column(conn, "resources", "operating_hours INTEGER")
    ensure_column(conn, "resources", "last_maintenance TEXT")
    ensure_column(conn, "resources", "next_maintenance TEXT")
    ensure_column(conn, "resources", "health_score REAL")
    ensure_column(conn, "resources", "passport_id TEXT")
    ensure_column(conn, "resources", "transport_rate REAL")
    ensure_column(conn, "resources", "trust_score REAL")
    ensure_column(conn, "resources", "total_capacity REAL")
    ensure_column(conn, "resources", "available_capacity REAL")
    ensure_column(conn, "resources", "capacity_unit TEXT")
    ensure_column(conn, "resources", "response_hours REAL")
    ensure_column(conn, "resources", "completion_rate REAL")
    ensure_column(conn, "resources", "cancellation_rate REAL")
    ensure_column(conn, "bookings", "buyer_id TEXT")
    ensure_column(conn, "production_requests", "buyer_id TEXT")
    ensure_column(conn, "notifications", "severity TEXT DEFAULT 'Medium'")
    ensure_column(conn, "notifications", "related_entity_type TEXT")
    ensure_column(conn, "notifications", "related_entity_id TEXT")
    ensure_column(conn, "notifications", "action_label TEXT")
    ensure_column(conn, "notifications", "is_read INTEGER DEFAULT 0")
    ensure_column(conn, "notifications", "recipient_user_id TEXT")
    ensure_column(conn, "notifications", "recipient_role TEXT")
    # Existing prototype records predate accounts. Assign them to the seeded
    # buyer so every mutable record has an owner without deleting legacy data.
    conn.execute("UPDATE bookings SET buyer_id = 'U-BUYER' WHERE buyer_id IS NULL")
    conn.execute("UPDATE production_requests SET buyer_id = 'U-BUYER' WHERE buyer_id IS NULL")
    conn.execute("UPDATE resources SET total_capacity = COALESCE(total_capacity, capacity_per_day, 120), available_capacity = COALESCE(available_capacity, capacity_per_day, 80), capacity_unit = COALESCE(capacity_unit, 'units/day'), health_score = COALESCE(health_score, 80), trust_score = COALESCE(trust_score, rating * 20)")
    conn.executemany(
        "INSERT OR IGNORE INTO industrial_clusters (name, city, state, region) VALUES (?, ?, ?, ?)",
        INDUSTRIAL_CLUSTERS,
    )
    for account in DEMO_USERS:
        conn.execute(
            """
            INSERT OR IGNORE INTO users
            (id, username, password_hash, display_name, role, owner_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                account["id"], account["username"],
                generate_password_hash(account["password"]),
                account["display_name"], account["role"], account["owner_id"],
                today_iso(),
            ),
        )
    count = conn.execute("SELECT COUNT(*) FROM resources").fetchone()[0]
    if count == 0:
        seed_resources = [
            ("R-101", "5-axis VMC", "Machinery", "Peenya", 7600, 1, 4.8, 1, "O-100", "Srinivasa Tools", "High-precision machining for automotive skids and die components.", json.dumps(["precision", "automotive"]), "2026-07-10"),
            ("R-102", "Cold Storage Bay", "Warehouse Space", "Bhosari", 4200, 1, 4.6, 1, "O-101", "Harsha Logistics", "Climate-controlled storage for pharma and food grade inventory.", json.dumps(["cold-chain"]), "2026-07-11"),
            ("R-103", "Coordinate Measuring Machine", "Testing Equipment", "Sriperumbudur", 5400, 1, 4.9, 0, "O-102", "Apex Precision", "Inspection for tight dimensional tolerance and quality audits.", json.dumps(["inspection"]), "2026-07-12"),
            ("R-104", "Certified CNC Operator", "Skilled Operator", "Tirupur", 3600, 1, 4.7, 1, "O-103", "Mitra Components", "Experienced operator for milling and turning jobs.", json.dumps(["operator"]), "2026-07-13"),
            ("R-105", "Box Truck 14ft", "Logistics Vehicle", "Peenya", 3100, 1, 4.5, 1, "O-104", "Kiran Freight", "Urban and intercity transport for component dispatch.", json.dumps(["transport"]), "2026-07-14"),
            ("R-106", "Powder Coating Booth", "Machinery", "Bhosari", 6800, 0, 4.2, 1, "O-105", "Ravi Surface Works", "Powder coating booth for metal finish jobs.", json.dumps(["finishing"]), "2026-07-15"),
            ("R-107", "Inspection Lab", "Testing Equipment", "Chennai", 5000, 0, 4.1, 1, "O-106", "Nexa Labs", "Lab-grade inspection for electronics and packaging components.", json.dumps(["lab"]), "2026-07-16"),
            ("R-108", "Forklift + Driver", "Logistics Vehicle", "Tirupur", 2800, 1, 4.4, 1, "O-107", "Sundaram Yard", "Short move assistance for loading and unloading.", json.dumps(["forklift"]), "2026-07-17"),
        ]
        conn.executemany(
            """
            INSERT INTO resources (id, name, category, cluster, price_per_day, verified, rating, availability, owner_id, owner_name, description, tags, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            seed_resources,
        )
        seed_bookings = [
            ("B-201", "Shan Engineering", "Completed", 7600, "2026-07-19", 5, json.dumps(["R-101"]), "Delivered on time"),
            ("B-202", "Veda Pack", "In Progress", 7300, "2026-08-01", None, json.dumps(["R-102", "R-105"]), "Bundle request in progress"),
            ("B-203", "Avi Components", "Completed", 3600, "2026-08-05", 4, json.dumps(["R-104"]), "Operator completed job")
        ]
        conn.executemany(
            """
            INSERT INTO bookings (id, buyer, status, total, created_at, rating, resources_json, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            seed_bookings,
        )
        seed_notifications = [
            ("N-001", "Verification pending", "New listing for Powder Coating Booth requires admin review.", "approval", "2026-08-08"),
            ("N-002", "Bundle booking created", "Veda Pack created a multi-resource bundle request.", "booking", "2026-08-08"),
            ("N-003", "Carbon insight ready", "Your latest booking avoided 18 kg CO2 compared to ownership.", "insight", "2026-08-08")
        ]
        conn.executemany(
            "INSERT INTO notifications (id, title, detail, kind, created_at) VALUES (?, ?, ?, ?, ?)",
            seed_notifications,
        )
    conn.commit()
    conn.close()


init_db()


def serve_app_shell():
    """Serve the React build when available, with the legacy UI as fallback."""
    if os.path.isfile(os.path.join(FRONTEND_DIST, "index.html")):
        response = send_from_directory(FRONTEND_DIST, "index.html")
    else:
        response = send_from_directory(APP_ROOT, "index.html")
    # The shell points at content-hashed bundles and must see each deployment.
    response.cache_control.no_cache = True
    return response


@app.route("/")
def root():
    return serve_app_shell()


@app.route("/index.html")
def index_html():
    return serve_app_shell()


@app.route("/assets/<path:filename>")
def frontend_asset(filename):
    # send_from_directory performs a safe path join and returns 404 for paths
    # outside the Vite assets directory. Vite filenames are content-hashed.
    response = send_from_directory(FRONTEND_ASSETS, filename, max_age=31536000)
    response.cache_control.public = True
    response.cache_control.max_age = 31536000
    response.cache_control.immutable = True
    return response


@app.route("/styles.css")
def styles_css():
    return send_from_directory(APP_ROOT, "styles.css")


@app.route("/app.js")
def app_js():
    return send_from_directory(APP_ROOT, "app.js")


@app.route("/copilot-worker.js")
def copilot_worker():
    return send_from_directory(APP_ROOT, "copilot-worker.js")


@app.route("/explanation.html")
def explanation_html():
    return send_from_directory(APP_ROOT, "explanation.html")


@app.route("/manifest.json")
def manifest_json():
    return send_from_directory(APP_ROOT, "manifest.json")


@app.route("/sw.js")
def service_worker():
    return send_from_directory(APP_ROOT, "sw.js")


@app.route("/api/auth/session")
def auth_session():
    user = current_user()
    return jsonify({"ok": True, "authenticated": bool(user), "user": user})


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return api_error("invalid_payload", "Expected a JSON object.", 400)
    username = str(payload.get("username") or payload.get("email") or "").strip().lower()
    password = payload.get("password")
    if not username or not isinstance(password, str) or not password:
        return api_error("invalid_credentials", "Username and password are required.", 400)
    if len(username) > 80 or len(password) > 200:
        return api_error("invalid_credentials", "Invalid username or password.", 401)

    conn = get_db()
    try:
        row = conn.execute(
            """
            SELECT id, username, password_hash, display_name, role, owner_id
            FROM users WHERE LOWER(username) = ?
            """,
            (username,),
        ).fetchone()
    finally:
        conn.close()
    if not row or not check_password_hash(row["password_hash"], password):
        return api_error("invalid_credentials", "Invalid username or password.", 401)

    session.clear()
    session["user_id"] = row["id"]
    # Distinguishes two simultaneous logins of the same account. Copilot
    # confirmation tokens are therefore bound to one login, not just a role.
    session["copilot_act_nonce"] = secrets.token_urlsafe(24)
    user = serialize_user(row)
    g.frep_user = user
    return jsonify({"ok": True, "user": user})


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    g.frep_user = None
    return jsonify({"ok": True})


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "service": "FREP backend", "ai": engine_status()})


@app.route("/api/dashboard")
def dashboard():
    conn = get_db()
    resources = conn.execute("SELECT * FROM resources").fetchall()
    bookings = conn.execute("SELECT * FROM bookings").fetchall()
    verified = sum(1 for row in resources if row["verified"])
    avg_cost = round(sum(row["price_per_day"] for row in resources) / len(resources), 0) if resources else 0
    active = sum(1 for row in bookings if row["status"] != "Completed")
    capex_avoided = round(sum(row["price_per_day"] * 15 for row in resources if row["verified"]) / 1000, 0)
    available_resources = sum(1 for row in resources if row["availability"])
    pending_verifications = sum(1 for row in resources if not row["verified"])
    conn.close()
    return jsonify({
        "resources_listed": len(resources),
        "available_resources": available_resources,
        "pending_verifications": pending_verifications,
        "verified_msmes": verified,
        "average_cost_per_day": int(avg_cost),
        "active_bookings": active,
        "capex_avoided": int(capex_avoided),
    })


@app.route("/api/resources")
def resource_list():
    qtype = request.args.get("resourceType", "")
    cluster = request.args.get("cluster", "")
    search = request.args.get("search", "")
    budget = request.args.get("budget", "")
    sort = request.args.get("sort", "score")
    owner_id = request.args.get("owner_id")
    results = []
    for item in load_catalog():
        if owner_id and item["ownerId"] != owner_id:
            continue
        if qtype and item["category"] != qtype and qtype.lower() not in item["name"].lower():
            continue
        if cluster and cluster.lower() not in item["cluster"].lower():
            continue
        if search and search.lower() not in f"{item['name']} {item['category']} {item['cluster']}".lower():
            continue
        if budget and item["pricePerDay"] > int(budget):
            continue
        results.append(item)
    if sort == "price":
        results.sort(key=lambda item: item["pricePerDay"])
    elif sort == "rating":
        results.sort(key=lambda item: item["rating"], reverse=True)
    else:
        results.sort(key=lambda item: (not item["verified"], -item["pricePerDay"]), reverse=False)
    return jsonify(results)


@app.route("/api/clusters")
def cluster_list():
    return jsonify(load_cluster_directory())


@app.route("/api/ai/status")
def ai_status():
    return jsonify({"ok": True, **engine_status()})


@app.route("/api/ai/parse", methods=["POST"])
def ai_parse():
    payload = request.get_json(silent=True) or {}
    text = payload.get("text") or payload.get("message") or ""
    parsed = parse_requirement(text, load_cluster_directory())
    return jsonify({"ok": True, "engine": engine_status(), **parsed})


@app.route("/api/ai/chat", methods=["POST"])
def ai_chat():
    payload = request.get_json(silent=True) or {}
    message = payload.get("message") or payload.get("text") or ""
    resources = load_catalog()
    clusters = load_cluster_directory()
    dashboard_hint = ""
    try:
        conn = get_db()
        count = conn.execute("SELECT COUNT(*) AS n FROM resources").fetchone()["n"]
        conn.close()
        dashboard_hint = f"Listed resources: {count}."
    except sqlite3.Error:
        dashboard_hint = ""
    result = answer_query(message, resources, clusters, extra_context=dashboard_hint)
    return jsonify(result)


@app.route("/api/match", methods=["POST"])
def match_resources():
    payload = request.get_json(silent=True)
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        return api_error("invalid_payload", "Expected a JSON object.", 400)
    results = rank_resource_matches(payload, load_catalog(), limit=40)
    return jsonify({"ok": True, "engine": engine_status(), "results": results})


@app.route("/api/copilot/typeahead", methods=["POST"])
@require_roles("buyer", "owner")
def copilot_typeahead():
    started = perf_counter()
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return api_error("invalid_payload", "Expected a JSON object.", 400)
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        return api_error("invalid_text", "Typeahead text must be a non-empty string.", 400)
    if len(text) > MAX_COMPOSE_TEXT_LENGTH:
        return api_error(
            "text_too_long",
            f"Typeahead text is limited to {MAX_COMPOSE_TEXT_LENGTH} characters.",
            413,
        )
    context = payload.get("context") or {}
    if not isinstance(context, dict):
        return api_error("invalid_context", "context must be a JSON object.", 400)
    try:
        if len(json.dumps(context)) > 12000:
            return api_error("context_too_large", "Typeahead context is too large.", 413)
    except (TypeError, ValueError):
        return api_error("invalid_context", "context must contain JSON values.", 400)

    user = current_user()
    session_role = user["role"]  # The client-supplied role is intentionally ignored.
    raw_source = str(context.get("source") or "").strip().lower().replace("_", "-")
    source_aliases = {
        "nlmatchinput": "search", "match": "search", "marketplace": "search",
        "plannernl": "planner", "production": "planner", "production-planner": "planner",
        "new-listing": "listing", "newlisting": "listing", "listings": "listing",
    }
    source = source_aliases.get(raw_source, raw_source)
    allowed_sources = {"search", "planner"} if session_role == "buyer" else {"search", "listing"}
    if source not in allowed_sources:
        source = "listing" if session_role == "owner" else "search"
    safe_context = {**context, "source": source}
    clusters = load_cluster_directory()
    fields = extract_partial_fields(text, clusters, source=source)

    form_context = context.get("form") if isinstance(context.get("form"), dict) else context
    match_payload = {"search": text, "sort": "score"}
    for key in ("cluster", "budget", "quantity", "material", "verifiedOnly", "availableOnly"):
        value = form_context.get(key)
        if value not in (None, ""):
            match_payload[key] = value
    resource_type = form_context.get("resourceType") or form_context.get("category")
    if resource_type:
        match_payload["resourceType"] = resource_type
    for key, field in fields.items():
        value = field["value"]
        if key == "category":
            match_payload["resourceType"] = value
        elif key == "deadline":
            match_payload["deadline"] = value
        elif key == "pricePerDay":
            # A listing price helps compare similar listings but is not a user
            # budget constraint, so it does not remove higher-priced matches.
            continue
        elif key in {"cluster", "budget", "quantity", "material", "verifiedOnly", "availableOnly", "processes"}:
            match_payload[key] = value

    matches = rank_resource_matches(match_payload, load_catalog(), limit=3)
    completion = contextual_completion(text, session_role, safe_context, clusters)
    duration_ms = round((perf_counter() - started) * 1000, 2)
    local_engine = {
        **engine_status(),
        "mode": "local-typeahead",
        "label": "FREP local Compose (rules + TF-IDF)",
        "path": "deterministic-local",
    }
    return jsonify({
        "ok": True,
        "completion": completion,
        "fields": fields,
        "matches": matches[:3],
        "engine": local_engine,
        "durationMs": duration_ms,
    })


@app.route("/api/copilot/typeahead/stream", methods=["POST"])
@require_roles("buyer", "owner")
def copilot_typeahead_stream():
    """Optionally stream a grounded cloud upgrade after local Compose renders."""
    if not engine_status()["cloudEnabled"]:
        return "", 204, {"X-FREP-Compose-Stream": "local-only"}
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return api_error("invalid_payload", "Expected a JSON object.", 400)
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        return api_error("invalid_text", "Typeahead text must be a non-empty string.", 400)
    if len(text) > MAX_COMPOSE_TEXT_LENGTH:
        return api_error(
            "text_too_long",
            f"Typeahead text is limited to {MAX_COMPOSE_TEXT_LENGTH} characters.",
            413,
        )
    context = payload.get("context") or {}
    if not isinstance(context, dict):
        return api_error("invalid_context", "context must be a JSON object.", 400)
    try:
        if len(json.dumps(context)) > 12000:
            return api_error("context_too_large", "Typeahead context is too large.", 413)
    except (TypeError, ValueError):
        return api_error("invalid_context", "context must contain JSON values.", 400)

    role = current_user()["role"]
    source = str(context.get("source") or "").strip().lower().replace("_", "-")
    aliases = {
        "nlmatchinput": "search", "match": "search", "marketplace": "search",
        "plannernl": "planner", "production": "planner", "production-planner": "planner",
        "new-listing": "listing", "newlisting": "listing", "listings": "listing",
    }
    source = aliases.get(source, source)
    allowed_sources = {"search", "planner"} if role == "buyer" else {"search", "listing"}
    if source not in allowed_sources:
        source = "listing" if role == "owner" else "search"

    clusters = load_cluster_directory()
    fields = extract_partial_fields(text, clusters, source=source)
    form_context = context.get("form") if isinstance(context.get("form"), dict) else context
    match_payload = {"search": text, "sort": "score"}
    for key in ("cluster", "budget", "quantity", "material", "verifiedOnly", "availableOnly"):
        value = form_context.get(key)
        if value not in (None, ""):
            match_payload[key] = value
    resource_type = form_context.get("resourceType") or form_context.get("category")
    if resource_type:
        match_payload["resourceType"] = resource_type
    for key, field in fields.items():
        value = field["value"]
        if key == "category":
            match_payload["resourceType"] = value
        elif key == "deadline":
            match_payload["deadline"] = value
        elif key != "pricePerDay":
            match_payload[key] = value
    matches = rank_resource_matches(match_payload, load_catalog(), limit=3)
    chunks, mode = stream_compose_completion(text, source, fields, matches)
    if chunks is None:
        return "", 204, {"X-FREP-Compose-Stream": "local-only"}

    def event_stream():
        completion = ""
        yield f"event: meta\ndata: {json.dumps({'engine': mode})}\n\n"
        try:
            for chunk in chunks:
                if not chunk or len(completion) >= 220:
                    continue
                token = str(chunk)[: 220 - len(completion)]
                completion += token
                yield f"event: token\ndata: {json.dumps({'token': token, 'engine': mode})}\n\n"
            yield f"event: complete\ndata: {json.dumps({'completion': completion, 'engine': mode})}\n\n"
        except Exception:
            # The already-rendered local suggestion remains usable. Do not
            # expose provider or credential details in the browser response.
            yield f"event: fallback\ndata: {json.dumps({'local': True})}\n\n"

    return Response(
        stream_with_context(event_stream()),
        content_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"},
    )


def _compose_field_values(fields):
    return {
        key: item.get("value")
        for key, item in (fields or {}).items()
        if isinstance(item, dict) and item.get("value") not in (None, "", [])
    }


def _copilot_match_filters(instruction, values):
    filters = {"search": instruction, "sort": "score"}
    aliases = {
        "category": "resourceType",
        "deadline": "deadline",
        "cluster": "cluster",
        "budget": "budget",
        "quantity": "quantity",
        "material": "material",
        "processes": "processes",
        "verifiedOnly": "verifiedOnly",
        "availableOnly": "availableOnly",
    }
    for source_key, target_key in aliases.items():
        value = values.get(source_key)
        if value not in (None, "", []):
            filters[target_key] = value
    return filters


def _infer_listing_category(instruction, extracted_category=None):
    if extracted_category:
        return extracted_category
    lower = instruction.lower()
    def has_any(terms):
        return any(
            re.search(rf"(?<!\w){re.escape(term)}(?!\w)", lower, re.UNICODE)
            for term in terms
        )

    if has_any(("warehouse", "storage", "shed", "bay")):
        return "Warehouse Space"
    if has_any(("truck", "forklift", "vehicle", "logistics")):
        return "Logistics Vehicle"
    if has_any(("operator", "welder", "technician", "manpower")):
        return "Skilled Operator"
    if has_any(("inspection", "testing", "cmm", "laboratory", "lab")):
        return "Testing Equipment"
    return "Machinery"


def _listing_name_from_instruction(instruction, extracted_name=None):
    if extracted_name:
        candidate = str(extracted_name)
    else:
        candidate = re.sub(
            r"^\s*(?:please\s+)?(?:list|add|publish|offer)\s+(?:my\s+|an?\s+|the\s+)?",
            "",
            instruction,
            flags=re.I,
        )
        candidate = re.split(
            r"\s+(?:in|near|at|for|with|available|priced)\b",
            candidate,
            maxsplit=1,
            flags=re.I,
        )[0]
    candidate = re.sub(r"^(?:my|our)\s+", "", candidate.strip(" ,.-"), flags=re.I)
    return candidate[:120]


def _listing_cluster_from_instruction(instruction, extracted_cluster=None):
    if extracted_cluster:
        return str(extracted_cluster).strip()[:100]
    # Owners may list a valid new manufacturing hub before admins enrich the
    # optional directory metadata. Keep this conservative and visible in the
    # signed draft; confirmation never inserts a directory row implicitly.
    match = re.search(
        r"\b(?:in|near)\s+([a-z][a-z .'-]{1,80}?)"
        r"(?=\s+(?:at|for|with|available|priced|under)\b|[,.;]|$)",
        instruction,
        re.I,
    )
    return match.group(1).strip(" ,.-")[:100] if match else ""


def _issue_copilot_confirmation(user, proposal_id, action, draft):
    session_nonce = session.get("copilot_act_nonce")
    if not isinstance(session_nonce, str) or len(session_nonce) < 16:
        # Supports signed sessions created before this additive feature landed.
        session_nonce = secrets.token_urlsafe(24)
        session["copilot_act_nonce"] = session_nonce
    token_payload = {
        "version": 1,
        "proposalId": proposal_id,
        "userId": user["id"],
        "role": user["role"],
        "sessionNonce": session_nonce,
        "action": action,
        "draft": draft,
        "issuedAt": now_iso(),
    }
    return copilot_action_serializer().dumps(token_payload)


def _copilot_act_response(
    *, proposal_id, action, draft, filters, fields, matches, summary,
    confirmable, token=None, warnings=None, missing_fields=None,
):
    requires_confirmation = action in {"createBooking", "createListing"}
    confirmation = {
        "endpoint": "/api/copilot/act/confirm",
        "method": "POST",
        "tokenField": "confirmationToken",
        "expiresInSeconds": COPILOT_ACTION_TOKEN_TTL_SECONDS,
        "required": requires_confirmation,
    }
    if token:
        confirmation["body"] = {"confirmationToken": token}
    return {
        "ok": True,
        "proposalId": proposal_id,
        "action": action,
        "actionType": {
            "createBooking": "booking.create",
            "createListing": "listing.create",
            "searchResources": "resource.search",
        }[action],
        "draft": draft,
        "filters": filters,
        "fields": fields,
        "matches": matches,
        "summary": summary,
        "message": summary,
        "confirmable": bool(confirmable),
        "requiresConfirmation": requires_confirmation,
        "confirmationToken": token,
        "confirmation": confirmation,
        "warnings": warnings or [],
        "missingFields": missing_fields or [],
    }


@app.route("/api/copilot/act", methods=["POST"])
@require_roles("buyer", "owner")
def copilot_act():
    """Build a grounded action proposal without making a marketplace write."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return api_error("invalid_payload", "Expected a JSON object.", 400)
    instruction = payload.get("instruction") or payload.get("text") or payload.get("message")
    if not isinstance(instruction, str) or not instruction.strip():
        return api_error("invalid_instruction", "instruction must be a non-empty string.", 400)
    instruction = instruction.strip()
    if len(instruction) > MAX_COMPOSE_TEXT_LENGTH:
        return api_error(
            "instruction_too_long",
            f"Instructions are limited to {MAX_COMPOSE_TEXT_LENGTH} characters.",
            413,
        )

    user = current_user()
    proposal_id = f"CPA-{uuid.uuid4().hex[:16].upper()}"
    clusters = load_cluster_directory()
    catalogue = load_catalog()

    if user["role"] == "owner":
        fields = extract_partial_fields(instruction, clusters, source="listing")
        values = _compose_field_values(fields)
        name = _listing_name_from_instruction(instruction, values.get("name"))
        category = _infer_listing_category(instruction, values.get("category"))
        cluster = _listing_cluster_from_instruction(instruction, values.get("cluster"))
        price_per_day = as_int(values.get("pricePerDay"), 0)
        description = str(values.get("description") or instruction).strip()[:500]
        tag_values = []
        if values.get("material"):
            tag_values.append(str(values["material"]).lower())
        if values.get("processes"):
            tag_values.extend(
                item.strip().lower()
                for item in str(values["processes"]).split(",")
                if item.strip()
            )
        draft = {
            "name": name,
            "category": category,
            "cluster": cluster,
            "pricePerDay": price_per_day,
            "availability": True,
            "description": description,
            "tags": list(dict.fromkeys(tag_values))[:10] or ["copilot-draft"],
        }
        missing_fields = []
        if len(name) < 3:
            missing_fields.append("name")
        if not cluster:
            missing_fields.append("cluster")
        if price_per_day <= 0:
            missing_fields.append("pricePerDay")
        confirmable = not missing_fields
        token = (
            _issue_copilot_confirmation(user, proposal_id, "createListing", draft)
            if confirmable else None
        )
        summary = (
            f"Draft listing: {name} in {cluster} at Rs {price_per_day:,}/day. "
            "It will remain unverified until an admin reviews it."
            if confirmable else
            "I prepared a listing draft, but it needs " + ", ".join(missing_fields) + " before it can be confirmed."
        )
        return jsonify(_copilot_act_response(
            proposal_id=proposal_id,
            action="createListing",
            draft=draft,
            filters={},
            fields=fields,
            matches=[],
            summary=summary,
            confirmable=confirmable,
            token=token,
            missing_fields=missing_fields,
        ))

    fields = extract_partial_fields(instruction, clusters, source="search")
    values = _compose_field_values(fields)
    filters = _copilot_match_filters(instruction, values)
    counted_resource_match = re.search(
        r"\b(?:find|show|need|source|locate|get)\s+(?:me\s+)?"
        r"(?P<count>[1-3]|one|two|three)\s+"
        r"(?:[a-z0-9-]+\s+){0,4}"
        r"(?:machines?|resources?|equipment|listings?|operators?|vehicles?|warehouses?)\b",
        instruction,
        re.I,
    )
    count_words = {"one": 1, "two": 2, "three": 3}
    requested_resource_count = 0
    if counted_resource_match:
        raw_count = counted_resource_match.group("count").lower()
        requested_resource_count = count_words.get(raw_count, as_int(raw_count, 0))
    booking_intent = bool(re.search(
        r"\b(?:book|reserve|rent|hire|secure)\b|\bmake\s+(?:a\s+)?booking\b",
        instruction,
        re.I,
    )) or requested_resource_count > 0
    if not booking_intent:
        matches = rank_resource_matches(filters, catalogue, limit=5)
        summary = f"Found {len(matches)} grounded catalogue match(es); no write is proposed."
        return jsonify(_copilot_act_response(
            proposal_id=proposal_id,
            action="searchResources",
            draft={"filters": filters},
            filters=filters,
            fields=fields,
            matches=matches,
            summary=summary,
            confirmable=False,
        ))

    # A booking proposal is stricter than search: unverified or unavailable
    # listings can be shown elsewhere, but can never enter this signed draft.
    filters["verifiedOnly"] = True
    filters["availableOnly"] = True
    matches = rank_resource_matches(filters, catalogue, limit=8)
    explicit_ids = list(dict.fromkeys(
        match.upper() for match in re.findall(r"\bR-[A-Z0-9-]+\b", instruction, re.I)
    ))
    catalogue_by_id = {item["id"].upper(): item for item in catalogue}
    warnings = []
    selected = []
    if explicit_ids:
        match_by_id = {item["id"].upper(): item for item in rank_resource_matches(
            {"verifiedOnly": True, "availableOnly": True}, catalogue, limit=len(catalogue)
        )}
        selected = [match_by_id[item_id] for item_id in explicit_ids if item_id in match_by_id]
        for item_id in explicit_ids:
            resource = catalogue_by_id.get(item_id)
            if not resource:
                warnings.append(f"{item_id} does not exist.")
            elif not resource.get("verified"):
                warnings.append(f"{item_id} is not verified.")
            elif not resource.get("availability"):
                warnings.append(f"{item_id} is not currently available.")
        # Keep the visible results aligned with an explicit request.
        matches = selected
    else:
        capabilities = _requested_capabilities(filters)
        desired_count = (
            requested_resource_count
            if requested_resource_count
            else max(1, min(3, len(capabilities)))
        )
        if re.search(r"\b(?:bundle|chain|together|multiple)\b", instruction, re.I):
            desired_count = max(desired_count, min(3, len(matches)))
        used_ids = set()
        for capability in capabilities:
            candidate = next((
                item for item in matches
                if item["id"] not in used_ids
                and capability.lower() in {
                    str(value).lower() for value in item.get("capabilities", [])
                }
            ), None)
            if candidate:
                selected.append(candidate)
                used_ids.add(candidate["id"])
        for item in matches:
            if len(selected) >= desired_count:
                break
            if item["id"] not in used_ids:
                selected.append(item)
                used_ids.add(item["id"])

    resource_ids = [
        item["id"] for item in selected
        if item.get("verified") and item.get("availability")
    ]
    if requested_resource_count and len(resource_ids) < requested_resource_count:
        warnings.append(
            f"Only {len(resource_ids)} of {requested_resource_count} requested resources are eligible."
        )
    confirmable = bool(resource_ids) and not warnings
    duration_days = max(1, as_int(values.get("deadline"), 1))
    estimated_daily_total = sum(as_int(item.get("pricePerDay"), 0) for item in selected)
    draft = {
        "resourceIds": resource_ids,
        "note": f"Copilot-confirmed request: {instruction}"[:500],
        "durationDays": duration_days,
        "requestedResourceCount": requested_resource_count or len(resource_ids),
        "estimatedDailyTotal": estimated_daily_total,
        "estimatedTotal": estimated_daily_total * duration_days,
    }
    token = (
        _issue_copilot_confirmation(user, proposal_id, "createBooking", draft)
        if confirmable else None
    )
    if confirmable:
        summary = (
            f"Draft bundle contains {len(resource_ids)} verified, available resource(s) "
            f"at an estimated Rs {estimated_daily_total:,}/day. Confirm to reserve it."
        )
    elif warnings:
        summary = "The requested bundle cannot be confirmed until every explicit resource is eligible."
    else:
        summary = "No verified, currently available resource matched this booking request."
    return jsonify(_copilot_act_response(
        proposal_id=proposal_id,
        action="createBooking",
        draft=draft,
        filters=filters,
        fields=fields,
        matches=matches[:5],
        summary=summary,
        confirmable=confirmable,
        token=token,
        warnings=warnings,
        missing_fields=(
            [] if confirmable else
            (["resourceIds"] if not resource_ids else ["requestedResourceCount"])
        ),
    ))


@app.route("/api/copilot/act/confirm", methods=["POST"])
@require_roles("buyer", "owner")
def confirm_copilot_act():
    """Execute only the signed booking/listing draft after a second POST."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return api_error("invalid_payload", "Expected a JSON object.", 400)
    token = payload.get("confirmationToken") or payload.get("confirmation_token") or payload.get("token")
    if not isinstance(token, str) or not token:
        return api_error("confirmation_token_required", "confirmationToken is required.", 400)
    try:
        proposal = copilot_action_serializer().loads(
            token,
            max_age=COPILOT_ACTION_TOKEN_TTL_SECONDS,
        )
    except SignatureExpired:
        return api_error(
            "confirmation_token_expired",
            "This proposal expired. Ask Copilot to prepare a fresh draft.",
            410,
        )
    except BadSignature:
        return api_error(
            "invalid_confirmation_token",
            "The confirmation token is invalid or has been changed.",
            400,
        )
    if not isinstance(proposal, dict) or proposal.get("version") != 1:
        return api_error("invalid_confirmation_token", "Unsupported confirmation token.", 400)

    user = current_user()
    session_nonce = session.get("copilot_act_nonce")
    token_nonce = proposal.get("sessionNonce")
    nonce_matches = (
        isinstance(session_nonce, str)
        and isinstance(token_nonce, str)
        and secrets.compare_digest(session_nonce, token_nonce)
    )
    if (
        proposal.get("userId") != user["id"]
        or proposal.get("role") != user["role"]
        or not nonce_matches
    ):
        return api_error(
            "confirmation_session_mismatch",
            "This proposal belongs to a different login session.",
            403,
        )
    proposal_id = str(proposal.get("proposalId") or "")
    requested_proposal_id = payload.get("proposalId")
    if requested_proposal_id and requested_proposal_id != proposal_id:
        return api_error("proposal_mismatch", "proposalId does not match the signed token.", 400)
    action = proposal.get("action")
    draft = proposal.get("draft")
    if action not in {"createBooking", "createListing"} or not isinstance(draft, dict):
        return api_error("unsupported_copilot_action", "This proposal cannot be confirmed.", 400)
    expected_role = "buyer" if action == "createBooking" else "owner"
    if user["role"] != expected_role:
        return api_error("forbidden", f"Only a {expected_role} can confirm this action.", 403)

    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        prior = conn.execute(
            "SELECT result_id, action, confirmed_at FROM copilot_confirmations WHERE proposal_id = ?",
            (proposal_id,),
        ).fetchone()
        if prior:
            conn.rollback()
            return api_error(
                "proposal_already_confirmed",
                "This proposal has already been confirmed.",
                409,
                {"resultId": prior["result_id"], "confirmedAt": prior["confirmed_at"]},
            )

        if action == "createBooking":
            safe_draft = {
                "resourceIds": draft.get("resourceIds"),
                "note": draft.get("note"),
                "source": "copilot-confirmed",
            }
            result = create_booking_record(conn, safe_draft, user)
        else:
            required = {
                "name": str(draft.get("name") or "").strip(),
                "cluster": str(draft.get("cluster") or "").strip(),
                "pricePerDay": as_int(draft.get("pricePerDay"), 0),
            }
            missing = [
                key for key, value in required.items()
                if (key == "pricePerDay" and value <= 0) or (key != "pricePerDay" and not value)
            ]
            if missing:
                raise FrepActionError(
                    "incomplete_listing_draft",
                    "The signed listing draft is incomplete.",
                    409,
                    missing,
                )
            safe_draft = {
                "name": required["name"],
                "category": str(draft.get("category") or "Machinery"),
                "cluster": required["cluster"],
                "pricePerDay": required["pricePerDay"],
                "availability": as_bool(draft.get("availability"), True),
                "description": str(draft.get("description") or required["name"]),
                "tags": draft.get("tags") if isinstance(draft.get("tags"), list) else ["copilot-draft"],
                "source": "copilot-confirmed",
            }
            resource_id = create_resource_record(conn, safe_draft, user)
            result = {"id": resource_id, "verified": False}

        conn.execute(
            """
            INSERT INTO copilot_confirmations
            (proposal_id, user_id, action, result_id, confirmed_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (proposal_id, user["id"], action, result["id"], now_iso()),
        )
        add_audit_log(
            conn,
            "copilot_proposal",
            proposal_id,
            "proposal_confirmed",
            actor_type=user["role"],
            actor_id=user["id"],
            metadata={"action": action, "resultId": result["id"]},
        )
        conn.commit()
    except FrepActionError as error:
        conn.rollback()
        return action_error_response(error)
    except sqlite3.IntegrityError:
        conn.rollback()
        return api_error(
            "proposal_already_confirmed",
            "This proposal has already been confirmed.",
            409,
        )
    finally:
        conn.close()
    message = (
        f"Booking {result['id']} was created after explicit confirmation."
        if action == "createBooking" else
        f"Listing {result['id']} was created unverified and sent for admin review."
    )
    return jsonify({
        "ok": True,
        "confirmed": True,
        "proposalId": proposal_id,
        "action": action,
        "id": result["id"],
        "result": result,
        "message": message,
    }), 201


@app.route("/api/resources", methods=["POST"])
@require_roles("owner")
def create_resource():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return api_error("invalid_payload", "Expected a JSON object.", 400)
    user = current_user()
    conn = get_db()
    try:
        resource_id = create_resource_record(conn, payload, user)
        conn.commit()
    except FrepActionError as error:
        conn.rollback()
        return action_error_response(error)
    finally:
        conn.close()
    return jsonify({"ok": True, "id": resource_id})


@app.route("/api/resources/<resource_id>", methods=["PATCH"])
@require_roles("owner", "admin")
def update_resource(resource_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not payload:
        return api_error("invalid_payload", "Expected a non-empty JSON object.", 400)
    user = current_user()
    conn = get_db()
    resource = conn.execute(
        "SELECT id, owner_id FROM resources WHERE id = ?", (resource_id,)
    ).fetchone()
    if not resource:
        conn.close()
        return api_error("resource_not_found", "Resource not found.", 404)

    requested_fields = set(payload)
    if user["role"] == "owner":
        if resource["owner_id"] != user["ownerId"]:
            conn.close()
            return api_error("not_resource_owner", "Owners may update only their own resources.", 403)
        forbidden = requested_fields - {"pricePerDay", "availability"}
        if forbidden:
            conn.close()
            return api_error(
                "forbidden_resource_fields",
                "Owners may update only pricePerDay and availability.",
                403,
                sorted(forbidden),
            )
    else:
        forbidden = requested_fields - {"verified"}
        if forbidden or "verified" not in payload:
            conn.close()
            return api_error(
                "forbidden_resource_fields",
                "Admins may update only verification status.",
                403,
                sorted(forbidden),
            )

    fields = []
    values = []
    verification_changed = None
    availability_changed = None
    if "pricePerDay" in payload:
        try:
            price = int(payload["pricePerDay"])
        except (TypeError, ValueError):
            conn.close()
            return api_error("invalid_price", "pricePerDay must be an integer.", 400)
        if price < 0:
            conn.close()
            return api_error("invalid_price", "pricePerDay cannot be negative.", 400)
        fields.append("price_per_day = ?")
        values.append(price)
    if "availability" in payload:
        fields.append("availability = ?")
        availability_changed = as_bool(payload["availability"])
        values.append(1 if availability_changed else 0)
    if "verified" in payload:
        fields.append("verified = ?")
        values.append(1 if as_bool(payload["verified"]) else 0)
        verification_changed = as_bool(payload["verified"])
    values.append(resource_id)
    if not fields:
        conn.close()
        return api_error("no_valid_fields", "No valid fields were supplied.", 400)
    conn.execute(f"UPDATE resources SET {', '.join(fields)} WHERE id = ?", values)
    if verification_changed is not None:
        add_notification(
            conn,
            "Listing verification updated",
            f"Resource {resource_id} has been {'approved' if verification_changed else 'rejected'}.",
            "verification",
            severity="High",
            related_type="resource",
            related_id=resource_id,
            action="View listing",
        )
    if availability_changed is not None:
        add_notification(
            conn,
            "Resource availability changed",
            f"Resource {resource_id} is now {'available' if availability_changed else 'unavailable'}.",
            "availability",
            related_type="resource",
            related_id=resource_id,
        )
    add_audit_log(
        conn,
        "resource",
        resource_id,
        "verification_updated" if verification_changed is not None else "listing_updated",
        actor_type=user["role"],
        actor_id=user["id"],
        metadata={key: payload[key] for key in sorted(payload)},
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/resources/<resource_id>", methods=["DELETE"])
@require_roles("owner")
def delete_resource(resource_id):
    user = current_user()
    conn = get_db()
    resource = conn.execute("SELECT owner_id FROM resources WHERE id = ?", (resource_id,)).fetchone()
    if not resource:
        conn.close()
        return api_error("resource_not_found", "Resource not found.", 404)
    if resource["owner_id"] != user["ownerId"]:
        conn.close()
        return api_error("not_resource_owner", "Owners may delete only their own resources.", 403)
    conn.execute("DELETE FROM resources WHERE id = ?", (resource_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/bookings")
def booking_list():
    user = current_user()
    conn = get_db()
    if user and user["role"] == "buyer":
        rows = conn.execute(
            "SELECT * FROM bookings WHERE buyer_id = ? ORDER BY created_at DESC",
            (user["id"],),
        ).fetchall()
    else:
        # Keep the original HTTP-200/list response shape for compatibility,
        # without exposing buyer activity to anonymous or non-buyer callers.
        rows = []
    bookings = []
    for row in rows:
        bookings.append({
            "id": row["id"],
            "buyer": row["buyer"],
            "status": row["status"],
            "total": row["total"],
            "created": row["created_at"],
            "rating": row["rating"],
            "resources": json.loads(row["resources_json"]),
            "note": row["note"],
        })
    conn.close()
    return jsonify(bookings)


@app.route("/api/bookings", methods=["POST"])
@require_roles("buyer")
def create_booking():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return api_error("invalid_payload", "Expected a JSON object.", 400)
    user = current_user()
    conn = get_db()
    try:
        # Serialize eligibility checks and reservation so concurrent buyers
        # cannot both reserve the same verified capacity.
        conn.execute("BEGIN IMMEDIATE")
        result = create_booking_record(conn, payload, user)
        conn.commit()
    except FrepActionError as error:
        conn.rollback()
        return action_error_response(error)
    finally:
        conn.close()
    return jsonify({"ok": True, "id": result["id"]})


@app.route("/api/bookings/<booking_id>", methods=["PATCH"])
@require_roles("buyer")
def update_booking(booking_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return api_error("invalid_payload", "Expected a JSON object.", 400)
    action = payload.get("action")
    user = current_user()
    conn = get_db()
    existing = conn.execute(
        "SELECT id, buyer_id FROM bookings WHERE id = ?", (booking_id,)
    ).fetchone()
    if not existing:
        conn.close()
        return api_error("booking_not_found", "Booking not found.", 404)
    if existing["buyer_id"] != user["id"]:
        conn.close()
        return api_error("forbidden", "You can only update your own bookings.", 403)
    notification = None
    if action == "complete":
        booking = conn.execute("SELECT buyer, resources_json FROM bookings WHERE id = ?", (booking_id,)).fetchone()
        if booking:
            resource_ids = json.loads(booking["resources_json"])
            for resource_id in resource_ids:
                conn.execute("UPDATE resources SET availability = 1 WHERE id = ?", (resource_id,))
            notification = (
                f"N-{uuid.uuid4().hex}",
                "Booking completed",
                f"Booking {booking_id} for {booking['buyer']} is now completed.",
                "booking",
                datetime.now().strftime("%Y-%m-%d"),
            )
        conn.execute("UPDATE bookings SET status = ? WHERE id = ?", ("Completed", booking_id))
    elif action == "rate":
        rating = as_int(payload.get("rating"), 0)
        if rating < 1 or rating > 5:
            conn.close()
            return api_error("invalid_rating", "rating must be between 1 and 5.", 400)
        conn.execute("UPDATE bookings SET rating = ? WHERE id = ?", (rating, booking_id))
        notification = (
            f"N-{uuid.uuid4().hex}",
            "Feedback recorded",
            f"Booking {booking_id} received a rating of {rating}.",
            "insight",
            datetime.now().strftime("%Y-%m-%d"),
        )
    else:
        conn.close()
        return api_error("invalid_booking_action", "action must be complete or rate.", 400)
    if notification:
        conn.execute(
            "INSERT INTO notifications (id, title, detail, kind, created_at) VALUES (?, ?, ?, ?, ?)",
            notification,
        )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/analytics")
def analytics():
    conn = get_db()
    try:
        resources = conn.execute("SELECT * FROM resources").fetchall()
        bookings = conn.execute(
            "SELECT id, status, created_at, resources_json FROM bookings"
        ).fetchall()
    finally:
        conn.close()

    resources_by_id = {
        str(row["id"]): row for row in resources if row_value(row, "id") is not None
    }
    resource_categories = {
        str(row_value(row, "category", "") or "Uncategorized")
        for row in resources
    }
    categories = list(ANALYTICS_CATEGORIES)
    categories.extend(sorted(resource_categories.difference(categories)))
    listed_counts = {category: 0 for category in categories}
    for resource in resources:
        category = str(row_value(resource, "category", "") or "Uncategorized")
        listed_counts[category] = listed_counts.get(category, 0) + 1

    parsed_bookings = []
    malformed_resource_lists = 0
    valid_booking_dates = []
    invalid_booking_dates = 0
    status_counts = {}
    for booking in bookings:
        resource_ids, malformed = _analytics_resource_ids(
            row_value(booking, "resources_json")
        )
        if malformed:
            malformed_resource_lists += 1
        status = str(row_value(booking, "status", "") or "").strip().casefold()
        status_label = str(row_value(booking, "status", "") or "Unknown").strip() or "Unknown"
        status_counts[status_label] = status_counts.get(status_label, 0) + 1
        created_at = _analytics_datetime(row_value(booking, "created_at"))
        if created_at is None:
            invalid_booking_dates += 1
        else:
            valid_booking_dates.append(created_at)
        parsed_bookings.append(
            {
                "id": str(row_value(booking, "id", "") or ""),
                "status": status,
                "createdAt": created_at,
                "resourceIds": resource_ids,
            }
        )

    # Demand is a count of distinct resource allocations inside non-cancelled,
    # non-draft bookings.  It therefore changes with the actual booking table.
    demand_counts = {category: 0 for category in categories}
    missing_demand_resource_references = 0
    demand_booking_count = 0
    demand_excluded_statuses = {"cancelled", "draft"}
    for booking in parsed_bookings:
        if booking["status"] in demand_excluded_statuses:
            continue
        demand_booking_count += 1
        for resource_id in booking["resourceIds"]:
            resource = resources_by_id.get(resource_id)
            if resource is None:
                missing_demand_resource_references += 1
                continue
            category = str(
                row_value(resource, "category", "") or "Uncategorized"
            )
            demand_counts[category] = demand_counts.get(category, 0) + 1

    # Anchor the four-month chart to data so seeded/legacy databases remain
    # meaningful and reproducible.  With no valid booking date, use the latest
    # resource date; only a completely undated database falls back to today.
    if valid_booking_dates:
        anchor_date = max(valid_booking_dates)
        trend_anchor_source = "latest_valid_booking"
    else:
        valid_resource_dates = [
            date
            for date in (
                _analytics_datetime(row_value(resource, "created_at"))
                for resource in resources
            )
            if date is not None
        ]
        if valid_resource_dates:
            anchor_date = max(valid_resource_dates)
            trend_anchor_source = "latest_valid_resource"
        else:
            anchor_date = datetime.now()
            trend_anchor_source = "current_month_fallback"
    trend_months = [
        _analytics_month(
            anchor_date.year,
            anchor_date.month,
            offset,
        )
        for offset in range(-(ANALYTICS_TREND_MONTHS - 1), 1)
    ]
    trend_lookup = {month: index for index, month in enumerate(trend_months)}
    trend = [0 for _ in trend_months]
    for booking in parsed_bookings:
        created_at = booking["createdAt"]
        if created_at is None:
            continue
        index = trend_lookup.get((created_at.year, created_at.month))
        if index is not None:
            trend[index] += 1
    month_labels = (
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    )
    trend_labels = [month_labels[month - 1] for _, month in trend_months]
    trend_periods = [f"{year:04d}-{month:02d}" for year, month in trend_months]
    trend_moving_average = []
    for index in range(len(trend)):
        window = trend[
            max(0, index - ANALYTICS_MOVING_AVERAGE_MONTHS + 1):index + 1
        ]
        trend_moving_average.append(round(sum(window) / len(window), 2))

    realized_carbon = _carbon_summary(
        parsed_bookings, resources_by_id, {"completed"}
    )
    projected_statuses = {
        state.casefold()
        for state in BOOKING_STATES
        if state not in {"Draft", "Completed", "Cancelled", "Disputed"}
    }
    projected_carbon = _carbon_summary(
        parsed_bookings, resources_by_id, projected_statuses
    )
    carbon_savings = realized_carbon["netSavedKg"]

    return jsonify({
        "categories": categories,
        "listed": [listed_counts.get(category, 0) for category in categories],
        "demand": [demand_counts.get(category, 0) for category in categories],
        "trendLabels": trend_labels,
        "trend": trend,
        "carbonSavings": carbon_savings,
        "trendPeriods": trend_periods,
        "trendMovingAverage": trend_moving_average,
        "trendBreakdown": {
            "anchorPeriod": f"{anchor_date.year:04d}-{anchor_date.month:02d}",
            "anchorSource": trend_anchor_source,
            "windowMonths": ANALYTICS_TREND_MONTHS,
            "movingAverageMonths": ANALYTICS_MOVING_AVERAGE_MONTHS,
            "bookingsInWindow": sum(trend),
            "validDatedBookings": len(valid_booking_dates),
            "invalidDatedBookings": invalid_booking_dates,
            "statusCounts": status_counts,
        },
        "demandBreakdown": {
            "bookingCount": demand_booking_count,
            "resourceAllocations": sum(demand_counts.values()),
            "missingResourceReferences": missing_demand_resource_references,
            "malformedResourceLists": malformed_resource_lists,
            "byCategory": [
                {
                    "category": category,
                    "listed": listed_counts.get(category, 0),
                    "demand": demand_counts.get(category, 0),
                }
                for category in categories
            ],
        },
        "carbonSavingsUnit": "kgCO2e",
        "carbonBreakdown": {
            **realized_carbon,
            "scope": "realized_completed_bookings",
            "distanceBasis": "estimated_proxy_not_observed",
            "observedDistanceAvailable": False,
            "projectedActive": projected_carbon,
        },
        "assumptions": {
            "demand": {
                "measure": "distinct resource ids per non-cancelled, non-draft booking",
                "missingResources": "ignored and reported in demandBreakdown",
            },
            "trend": {
                "measure": "all stored bookings with a parseable creation date",
                "window": "four calendar months ending at the latest valid booking month",
                "fallback": "latest valid resource month, then current month when the database has no dated records",
                "movingAverage": "trailing three-month mean using available periods at the start of the window",
            },
            "carbonSavings": {
                "methodologyVersion": "prototype-capacity-sharing-v1",
                "displayScope": "completed bookings only",
                "projectedScope": "active non-terminal bookings, reported separately",
                "formula": "max(0, sum(category capacity credit * utilization) - sum(distance proxy * transport emissions factor))",
                "categoryCapacityCreditKgPerAllocation": {
                    **CARBON_CAPACITY_CREDIT_KG,
                    "Other / uncategorized": CARBON_DEFAULT_CAPACITY_CREDIT_KG,
                },
                "utilization": "recorded utilization percentage; otherwise (total capacity - available capacity) / total capacity; otherwise 50%",
                "defaultUtilizationPercent": CARBON_DEFAULT_UTILIZATION_PERCENT,
                "distanceProxy": "transport_rate in INR divided by assumed INR/km; this is an estimated proxy because booking routes and observed kilometres are not stored",
                "defaultTransportRateInr": CARBON_DEFAULT_TRANSPORT_RATE_INR,
                "assumedTransportCostInrPerKm": CARBON_ASSUMED_TRANSPORT_COST_INR_PER_KM,
                "transportEmissionsKgPerKm": CARBON_TRANSPORT_EMISSIONS_KG_PER_KM,
                "caveat": "Planning estimate only; not measured emissions or an audited life-cycle assessment.",
            },
        },
    })


@app.route("/api/production/plan", methods=["POST"])
@require_roles("buyer")
def production_plan():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return api_error("invalid_payload", "Expected a JSON object.", 400)
    if payload.get("naturalLanguage"):
        parsed = parse_requirement(payload["naturalLanguage"], load_cluster_directory())
        payload = {**parsed, **{k: v for k, v in payload.items() if v not in (None, "")}}
    try:
        quantity = int(payload.get("quantity", 1))
        deadline_days = int(payload.get("deadline", 7))
        budget = int(payload.get("budget", 0))
    except (TypeError, ValueError):
        return api_error("invalid_requirements", "quantity, deadline, and budget must be integers.", 400)
    if quantity <= 0 or deadline_days <= 0 or budget < 0:
        return api_error(
            "invalid_requirements",
            "quantity and deadline must be positive; budget cannot be negative.",
            400,
        )
    requirements = {
        "product_name": payload.get("productName", "Untitled Product"),
        "quantity": quantity,
        "material": payload.get("material", "Unknown"),
        "processes": payload.get("processes", ""),
        "deadline_days": deadline_days,
        "budget": budget,
        "cluster": payload.get("cluster", ""),
        "quality": payload.get("quality", "Standard"),
        "transport_requirement": payload.get("transport", "Standard"),
    }
    capabilities = parse_production_requirement(requirements)
    conn = get_db()
    rows = conn.execute("SELECT * FROM resources ORDER BY created_at DESC").fetchall()
    resource_list = []
    for row in rows:
        resource_list.append({
            "id": row["id"],
            "name": row["name"],
            "category": row["category"],
            "cluster": row["cluster"],
            "pricePerDay": row["price_per_day"],
            "verified": bool(row["verified"]),
            "rating": row["rating"],
            "availability": bool(row["availability"]),
            "ownerId": row["owner_id"],
            "ownerName": row["owner_name"],
            "description": row["description"],
            "tags": json.loads(row["tags"]) if row["tags"] else [],
            "capabilities": json.loads(row["capabilities"]) if row["capabilities"] else infer_capabilities(
                row["category"],
                json.loads(row["tags"]) if row["tags"] else [],
                row["name"],
                row["description"],
            ),
            "transport_rate": row["transport_rate"] if row["transport_rate"] is not None else 1200,
            "capacityPerDay": row["capacity_per_day"] if row["capacity_per_day"] is not None else 0,
            "availableCapacity": row["available_capacity"] if row["available_capacity"] is not None else get_capacity({"category": row["category"]}),
            "healthScore": row["health_score"] if row["health_score"] is not None else 80,
            "trustScore": row["trust_score"] if row["trust_score"] is not None else round(row["rating"] * 20),
        })
    query = {
        "cluster": requirements["cluster"],
        "budget": requirements["budget"],
        "budget_specified": requirements["budget"] > 0,
        "deadline_days": requirements["deadline_days"],
        "capabilities": capabilities,
        "quantity": requirements["quantity"],
        "material": requirements["material"],
    }
    chain = build_resource_chain(resource_list, capabilities, query)
    bundles = compute_plan_options(chain, query)
    bundle_summary = {
        "capabilities": capabilities,
        "chain": [
            {
                "capability": item["capability"],
                "resource": format_resource(item["resource"]),
                "scoreBreakdown": item["scoreBreakdown"],
                "why": item["why"],
                "drivers": item["drivers"],
                "weights": item["weights"],
                "contributions": item["contributions"],
                "estimatedTransport": item["estimatedTransport"],
            }
            for item in chain
        ],
        "options": [
            {
                "label": option["label"],
                "estimatedTotal": option["estimatedTotal"],
                "estimatedDuration": option["estimatedDuration"],
                "estimatedTransport": option["estimatedTransport"],
                "risk": option["risk"],
                "score": option["score"],
            }
            for option in bundles
        ],
        "feasible": bool(chain),
        "decisionAnalysis": build_decision_analysis(bundles[0] if bundles else None, requirements),
    }
    request_id = f"PR-{uuid.uuid4().hex[:12].upper()}"
    conn.execute(
        "INSERT INTO production_requests (id, product_name, quantity, material, processes, deadline_days, budget, cluster, quality, transport_requirement, created_at, analyzed_capabilities, recommended_bundle, buyer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            request_id,
            requirements["product_name"],
            requirements["quantity"],
            requirements["material"],
            requirements["processes"],
            requirements["deadline_days"],
            requirements["budget"],
            requirements["cluster"],
            requirements["quality"],
            requirements["transport_requirement"],
            datetime.now().strftime("%Y-%m-%d"),
            json.dumps(capabilities),
            json.dumps(bundle_summary),
            current_user()["id"],
        ),
    )
    conn.commit()
    conn.close()
    return jsonify({
        "ok": True,
        "requestId": request_id,
        "requirements": requirements,
        "bundle": bundle_summary,
    })


@app.route("/api/notifications")
def notifications():
    user = current_user()
    conn = get_db()
    if user:
        rows = conn.execute(
            """
            SELECT * FROM notifications
            WHERE (recipient_user_id IS NULL OR recipient_user_id = ?)
              AND (recipient_role IS NULL OR LOWER(recipient_role) = ?)
            ORDER BY created_at DESC
            """,
            (user["id"], user["role"].lower()),
        ).fetchall()
    else:
        # Preserve the prototype's public broadcast feed for backward
        # compatibility, but never expose user- or role-targeted details.
        rows = conn.execute(
            """
            SELECT * FROM notifications
            WHERE recipient_user_id IS NULL AND recipient_role IS NULL
            ORDER BY created_at DESC
            """
        ).fetchall()
    items = [{"id": row["id"], "title": row["title"], "detail": row["detail"], "kind": row["kind"]} for row in rows]
    conn.close()
    return jsonify(items)


def _serialize_notification_event(row):
    return {
        "eventId": row["event_id"],
        "id": row["id"],
        "type": row["kind"],
        "kind": row["kind"],
        "title": row["title"],
        "detail": row["detail"],
        "createdAt": row["created_at"],
        "severity": row["severity"] or "Medium",
        "relatedEntityType": row["related_entity_type"],
        "relatedEntityId": row["related_entity_id"],
        "actionLabel": row["action_label"],
    }


@app.route("/api/events")
@app.route("/api/notifications/stream")
@require_roles("buyer", "owner", "admin")
def notification_event_stream():
    """Poll SQLite into authenticated SSE events; EventSource reconnects safely."""
    user = current_user()
    once = as_bool(request.args.get("once"), False)
    cursor_supplied = "after" in request.args or bool(request.headers.get("Last-Event-ID"))
    cursor_value = request.args.get("after")
    if cursor_value is None:
        cursor_value = request.headers.get("Last-Event-ID")
    try:
        cursor = max(0, int(cursor_value)) if cursor_value not in (None, "") else 0
    except (TypeError, ValueError):
        return api_error("invalid_event_cursor", "after must be a non-negative integer.", 400)
    if not cursor_supplied:
        conn = get_db()
        try:
            cursor = as_int(conn.execute(
                "SELECT COALESCE(MAX(rowid), 0) FROM notifications"
            ).fetchone()[0], 0)
        finally:
            conn.close()

    def read_events(after):
        conn = get_db()
        try:
            return conn.execute(
                """
                SELECT rowid AS event_id, * FROM notifications
                WHERE rowid > ?
                  AND (recipient_user_id IS NULL OR recipient_user_id = ?)
                  AND (recipient_role IS NULL OR LOWER(recipient_role) = ?)
                ORDER BY rowid ASC
                LIMIT 100
                """,
                (after, user["id"], user["role"].lower()),
            ).fetchall()
        finally:
            conn.close()

    def event_stream():
        nonlocal cursor
        connected_at = perf_counter()
        yield "retry: 2000\n"
        yield f"id: {cursor}\nevent: ready\ndata: {json.dumps({'ok': True, 'cursor': cursor})}\n\n"
        heartbeat_ticks = 0
        while True:
            try:
                rows = read_events(cursor)
            except sqlite3.Error:
                yield f"event: error\ndata: {json.dumps({'code': 'event_store_unavailable'})}\n\n"
                return
            for row in rows:
                cursor = row["event_id"]
                body = _serialize_notification_event(row)
                yield f"id: {cursor}\nevent: notification\ndata: {json.dumps(body)}\n\n"
            if once:
                return
            # Flask's demo session is a signed client cookie, so a stream that
            # never reconnects cannot observe a logout in another tab. Rotate
            # connections on a short bounded lifetime; the client re-checks
            # /api/auth/session before opening the next authenticated stream.
            if perf_counter() - connected_at >= SSE_CONNECTION_MAX_SECONDS:
                yield f"id: {cursor}\nevent: reconnect\ndata: {json.dumps({'cursor': cursor})}\n\n"
                return
            if rows:
                heartbeat_ticks = 0
            else:
                heartbeat_ticks += 1
                if heartbeat_ticks >= 10:
                    heartbeat_ticks = 0
                    yield f"event: heartbeat\ndata: {json.dumps({'cursor': cursor})}\n\n"
            sleep(1)

    return Response(
        stream_with_context(event_stream()),
        content_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("FREP_PORT", "8000")), debug=False)
