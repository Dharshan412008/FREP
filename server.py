import os
import json
import sqlite3
import uuid
from datetime import datetime, timedelta
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder=".", static_url_path="")
# FREP_DB_PATH is primarily useful for isolated automated tests.  The normal
# local application continues to use the checked-in SQLite file.
DB_PATH = os.environ.get("FREP_DB_PATH", os.path.join(os.path.dirname(__file__), "frep.db"))

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


def add_notification(conn, title, detail, kind, severity="Medium", related_type=None, related_id=None, action=None):
    conn.execute(
        """
        INSERT INTO notifications
        (id, title, detail, kind, created_at, severity, related_entity_type, related_entity_id, action_label, is_read)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            f"N-{uuid.uuid4().hex}", title, detail, kind, today_iso(), severity,
            related_type, related_id, action, 0,
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


def ensure_column(conn, table, column_def):
    try:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column_def}")
    except sqlite3.OperationalError:
        pass


def infer_capabilities(category, tags):
    capabilities = set()
    normalized_tags = [tag.lower() for tag in tags]
    if category in ["Machinery", "Logistics Vehicle"]:
        capabilities.add("Equipment & Logistics")
    if category == "Testing Equipment":
        capabilities.add("Quality Inspection")
    if category == "Skilled Operator":
        capabilities.add("Skilled Operator")
    if category == "Warehouse Space":
        capabilities.add("Storage")
    if any(tag in normalized_tags for tag in ["cnc", "milling", "machining", "precision", "turning", "lathe"]):
        capabilities.add("CNC Machining")
    if "coating" in normalized_tags or "finishing" in normalized_tags or "powder" in normalized_tags:
        capabilities.add("Surface Finishing")
    if "inspection" in normalized_tags or "lab" in normalized_tags or "quality" in normalized_tags:
        capabilities.add("Quality Inspection")
    if "operator" in normalized_tags:
        capabilities.add("Skilled Operator")
    if "forklift" in normalized_tags or "truck" in normalized_tags or "transport" in normalized_tags:
        capabilities.add("Logistics")
    if not capabilities:
        capabilities.add(category)
    return sorted(capabilities)


def parse_production_requirement(payload):
    processes = [item.strip() for item in payload.get("processes", "").split(",") if item.strip()]
    capabilities = set()
    for process in processes:
        lower = process.lower()
        if any(token in lower for token in ["cnc", "lathe", "mill", "machin"]):
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
    capability_match = 1.0 if capability in resource.get("capabilities", []) else 0.35
    location_match = 1.0 if resource.get("cluster") == query.get("cluster") else 0.75
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
    score = sum((
        capability_match * MATCH_WEIGHTS["capability"], capacity * MATCH_WEIGHTS["capacity"],
        availability * MATCH_WEIGHTS["availability"], location_match * MATCH_WEIGHTS["location"],
        cost_efficiency * MATCH_WEIGHTS["budget"], reliability * MATCH_WEIGHTS["reliability"],
        verification * MATCH_WEIGHTS["verification"], health * MATCH_WEIGHTS["health"],
        rating * MATCH_WEIGHTS["quality"], deadline * MATCH_WEIGHTS["deadline"],
        transport * MATCH_WEIGHTS["logistics"], material * MATCH_WEIGHTS["material"],
    ))
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
        "score": int(score * 100),
        "transportCost": transport_cost,
    }


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
    conn.execute("UPDATE resources SET total_capacity = COALESCE(total_capacity, capacity_per_day, 120), available_capacity = COALESCE(available_capacity, capacity_per_day, 80), capacity_unit = COALESCE(capacity_unit, 'units/day'), health_score = COALESCE(health_score, 80), trust_score = COALESCE(trust_score, rating * 20)")
    conn.executemany(
        "INSERT OR IGNORE INTO industrial_clusters (name, city, state, region) VALUES (?, ?, ?, ?)",
        INDUSTRIAL_CLUSTERS,
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


@app.route("/")
def root():
    return send_from_directory(os.path.dirname(__file__), "index.html")


@app.route("/index.html")
def index_html():
    return send_from_directory(os.path.dirname(__file__), "index.html")


@app.route("/styles.css")
def styles_css():
    return send_from_directory(os.path.dirname(__file__), "styles.css")


@app.route("/app.js")
def app_js():
    return send_from_directory(os.path.dirname(__file__), "app.js")


@app.route("/explanation.html")
def explanation_html():
    return send_from_directory(os.path.dirname(__file__), "explanation.html")


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "service": "FREP backend"})


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
    conn = get_db()
    qtype = request.args.get("resourceType", "")
    cluster = request.args.get("cluster", "")
    search = request.args.get("search", "")
    budget = request.args.get("budget", "")
    sort = request.args.get("sort", "score")
    owner_id = request.args.get("owner_id")
    rows = conn.execute("SELECT * FROM resources ORDER BY created_at DESC").fetchall()
    results = []
    for row in rows:
        tags = json.loads(row["tags"]) if row["tags"] else []
        item = {
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
            "capabilities": json.loads(row["capabilities"]) if row["capabilities"] else infer_capabilities(row["category"], tags),
            "totalCapacity": row["total_capacity"] if row["total_capacity"] is not None else get_capacity({"category": row["category"]}),
            "availableCapacity": row["available_capacity"] if row["available_capacity"] is not None else get_capacity({"category": row["category"]}),
            "capacityUnit": row["capacity_unit"] or "units/day",
            "healthScore": row["health_score"] if row["health_score"] is not None else 80,
            "trustScore": row["trust_score"] if row["trust_score"] is not None else round(row["rating"] * 20),
        }
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
    conn.close()
    return jsonify(results)


@app.route("/api/clusters")
def cluster_list():
    conn = get_db()
    clusters = [dict(row) for row in conn.execute(
        "SELECT name, city, state, region FROM industrial_clusters ORDER BY region, state, city, name"
    ).fetchall()]
    conn.close()
    return jsonify(clusters)


@app.route("/api/resources", methods=["POST"])
def create_resource():
    payload = request.get_json(silent=True) or {}
    resource_id = payload.get("id") or f"R-{110 + int(datetime.now().timestamp()) % 1000}"
    conn = get_db()
    conn.execute(
        """
        INSERT INTO resources (id, name, category, cluster, price_per_day, verified, rating, availability, owner_id, owner_name, description, tags, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            resource_id,
            payload.get("name", "New listing"),
            payload.get("category", "Machinery"),
            payload.get("cluster", "Peenya"),
            int(payload.get("pricePerDay", 0)),
            0,
            4.0,
            1,
            payload.get("ownerId", "O-100"),
            payload.get("ownerName", "Current MSME"),
            payload.get("description", "New listing waiting verification."),
            json.dumps(payload.get("tags", ["new"])),
            datetime.now().strftime("%Y-%m-%d"),
        ),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "id": resource_id})


@app.route("/api/resources/<resource_id>", methods=["PATCH"])
def update_resource(resource_id):
    payload = request.get_json(silent=True) or {}
    conn = get_db()
    fields = []
    values = []
    notification = None
    if "pricePerDay" in payload:
        fields.append("price_per_day = ?")
        values.append(int(payload["pricePerDay"]))
    if "availability" in payload:
        fields.append("availability = ?")
        values.append(1 if payload["availability"] else 0)
    if "verified" in payload:
        fields.append("verified = ?")
        values.append(1 if payload["verified"] else 0)
        notification = (
            f"N-{uuid.uuid4().hex}",
            "Listing verification updated",
            f"Resource {resource_id} has been {'approved' if payload['verified'] else 'rejected'}.",
            "approval",
            datetime.now().strftime("%Y-%m-%d"),
        )
    values.append(resource_id)
    if not fields:
        conn.close()
        return jsonify({"ok": False, "message": "No valid fields"})
    conn.execute(f"UPDATE resources SET {', '.join(fields)} WHERE id = ?", values)
    if notification:
        conn.execute(
            "INSERT INTO notifications (id, title, detail, kind, created_at) VALUES (?, ?, ?, ?, ?)",
            notification,
        )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/resources/<resource_id>", methods=["DELETE"])
def delete_resource(resource_id):
    conn = get_db()
    conn.execute("DELETE FROM resources WHERE id = ?", (resource_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/bookings")
def booking_list():
    conn = get_db()
    rows = conn.execute("SELECT * FROM bookings ORDER BY created_at DESC").fetchall()
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
def create_booking():
    payload = request.get_json(silent=True) or {}
    resource_ids = payload.get("resourceIds", [])
    buyer = payload.get("buyer", "Demo Buyer")
    conn = get_db()
    total = 0
    for resource_id in resource_ids:
        row = conn.execute("SELECT price_per_day FROM resources WHERE id = ?", (resource_id,)).fetchone()
        if row:
            total += row["price_per_day"]
            conn.execute("UPDATE resources SET availability = 0 WHERE id = ?", (resource_id,))
    booking_id = payload.get("id") or f"B-{100 + int(datetime.now().timestamp()) % 1000}"
    conn.execute(
        """
        INSERT INTO bookings (id, buyer, status, total, created_at, rating, resources_json, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (booking_id, buyer, "In Progress", total, datetime.now().strftime("%Y-%m-%d"), None, json.dumps(resource_ids), payload.get("note", "Booked through FREP")),
    )
    conn.execute(
        "INSERT INTO notifications (id, title, detail, kind, created_at) VALUES (?, ?, ?, ?, ?)",
        (f"N-{uuid.uuid4().hex}", "Booking received", f"{buyer} booked {len(resource_ids)} resource(s).", "booking", datetime.now().strftime("%Y-%m-%d")),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "id": booking_id})


@app.route("/api/bookings/<booking_id>", methods=["PATCH"])
def update_booking(booking_id):
    payload = request.get_json(silent=True) or {}
    action = payload.get("action")
    conn = get_db()
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
        rating = payload.get("rating")
        conn.execute("UPDATE bookings SET rating = ? WHERE id = ?", (rating, booking_id))
        notification = (
            f"N-{uuid.uuid4().hex}",
            "Feedback recorded",
            f"Booking {booking_id} received a rating of {rating}.",
            "insight",
            datetime.now().strftime("%Y-%m-%d"),
        )
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
    resources = conn.execute("SELECT category, price_per_day, verified FROM resources").fetchall()
    bookings = conn.execute("SELECT * FROM bookings").fetchall()
    categories = ["Machinery", "Warehouse Space", "Testing Equipment", "Skilled Operator", "Logistics Vehicle"]
    listed = []
    demand = [6, 3, 4, 5, 4]
    for category in categories:
        listed.append(sum(1 for row in resources if row["category"] == category))
    trend = [2, 3, 5, 4]
    # compute carbon impact
    carbon_savings = sum(18 for _ in bookings)
    conn.close()
    return jsonify({
        "categories": categories,
        "listed": listed,
        "demand": demand,
        "trendLabels": ["May", "Jun", "Jul", "Aug"],
        "trend": trend,
        "carbonSavings": carbon_savings,
    })


@app.route("/api/production/plan", methods=["POST"])
def production_plan():
    payload = request.get_json(silent=True) or {}
    requirements = {
        "product_name": payload.get("productName", "Untitled Product"),
        "quantity": int(payload.get("quantity", 1)),
        "material": payload.get("material", "Unknown"),
        "processes": payload.get("processes", ""),
        "deadline_days": int(payload.get("deadline", 7)),
        "budget": int(payload.get("budget", 0)),
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
            "capabilities": json.loads(row["capabilities"]) if row["capabilities"] else infer_capabilities(row["category"], json.loads(row["tags"]) if row["tags"] else []),
            "transport_rate": row["transport_rate"] if row["transport_rate"] is not None else 1200,
            "capacityPerDay": row["capacity_per_day"] if row["capacity_per_day"] is not None else 0,
            "availableCapacity": row["available_capacity"] if row["available_capacity"] is not None else get_capacity({"category": row["category"]}),
            "healthScore": row["health_score"] if row["health_score"] is not None else 80,
            "trustScore": row["trust_score"] if row["trust_score"] is not None else round(row["rating"] * 20),
        })
    query = {
        "cluster": requirements["cluster"],
        "budget": requirements["budget"],
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
    request_id = f"PR-{100 + int(datetime.now().timestamp()) % 10000}"
    conn.execute(
        "INSERT OR REPLACE INTO production_requests (id, product_name, quantity, material, processes, deadline_days, budget, cluster, quality, transport_requirement, created_at, analyzed_capabilities, recommended_bundle) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    conn = get_db()
    rows = conn.execute("SELECT * FROM notifications ORDER BY created_at DESC").fetchall()
    items = [{"id": row["id"], "title": row["title"], "detail": row["detail"], "kind": row["kind"]} for row in rows]
    conn.close()
    return jsonify(items)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("FREP_PORT", "8000")), debug=False)
