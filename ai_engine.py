"""
FREP Local Intelligence — free, on-device AI for MSME resource matching.

No paid API is required. The engine uses intent classification, entity
extraction, hybrid lexical/subword semantic ranking, and retrieval-augmented
answers.
If GROQ_API_KEY or GEMINI_API_KEY is present, those free-tier models
are used as an optional language layer and fall back locally on failure.
"""
from __future__ import annotations

import json
import math
import os
import re
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime

TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)
SEMANTIC_RANKER = "hybrid-tfidf-subword-v1"
SUBWORD_BUCKETS = 4096
STOPWORDS = {
    "a", "an", "the", "and", "or", "for", "to", "of", "in", "on", "at", "by",
    "with", "from", "is", "are", "be", "need", "want", "please", "i", "we",
    "our", "my", "me", "can", "you", "this", "that", "some", "any",
}

CATEGORY_ALIASES = {
    "cnc": "Machinery",
    "lathe": "Machinery",
    "mill": "Machinery",
    "vmc": "Machinery",
    "machine": "Machinery",
    "press": "Machinery",
    "warehouse": "Warehouse Space",
    "storage": "Warehouse Space",
    "cold": "Warehouse Space",
    "lab": "Testing Equipment",
    "cmm": "Testing Equipment",
    "inspect": "Testing Equipment",
    "testing": "Testing Equipment",
    "operator": "Skilled Operator",
    "manpower": "Skilled Operator",
    "welder": "Skilled Operator",
    "truck": "Logistics Vehicle",
    "logistics": "Logistics Vehicle",
    "forklift": "Logistics Vehicle",
    "transport": "Logistics Vehicle",
}

PROCESS_MAP = (
    (("cnc", "lathe", "mill", "machining", "vmc", "turning"), "CNC Machining"),
    (("finish", "finishing", "coating", "paint", "painting", "surface", "anodize", "anodizing", "polish", "polishing"), "Surface Finishing"),
    (("inspect", "inspection", "quality", "cmm", "testing", "lab", "laboratory"), "Quality Inspection"),
    (("operator", "skilled", "manpower", "welder"), "Skilled Operator"),
    (("truck", "logistic", "logistics", "transport", "forklift"), "Logistics"),
    (("warehouse", "storage", "cold"), "Storage"),
)

MATERIAL_ALIASES = {
    "aluminium": "Aluminium",
    "aluminum": "Aluminium",
    "mild steel": "Mild Steel",
    "stainless steel": "Stainless Steel",
    "stainless": "Stainless Steel",
    "ss304": "Stainless Steel",
    "brass": "Brass",
    "plastic": "Plastic",
    "copper": "Copper",
    "cast iron": "Cast Iron",
    "steel": "Steel",
}

# Web Speech returns the recognized language, not an English translation. This
# compact shop-floor vocabulary keeps the guaranteed local path useful for the
# four demo languages without a cloud translator or paid key. Unknown words are
# preserved, and explicit browser language controls remain available.
MULTILINGUAL_DOMAIN_ALIASES = (
    # Hindi (Devanagari)
    ("अगले सप्ताह", "next week"), ("प्रति दिन", "per day"),
    ("सीएनसी", "cnc"), ("सिएनसी", "cnc"), ("मशीन", "machine"),
    ("गोदाम", "warehouse"), ("भंडारण", "storage"),
    ("निरीक्षण", "inspection"), ("परीक्षण", "testing"),
    ("ऑपरेटर", "operator"), ("वेल्डर", "welder"), ("परिवहन", "transport"),
    ("उपलब्ध", "available"), ("सत्यापित", "verified"),
    ("बजट", "budget"), ("रुपये", "rs"), ("रुपया", "rs"),
    ("इकाइयाँ", "units"), ("इकाई", "unit"), ("दिन", "days"),
    ("एल्यूमीनियम", "aluminium"), ("अल्युमिनियम", "aluminium"),
    ("स्टेनलेस स्टील", "stainless steel"), ("स्टील", "steel"),
    # Tamil
    ("அடுத்த வாரம்", "next week"), ("ஒரு நாளுக்கு", "per day"),
    ("சிஎன்சி", "cnc"), ("இயந்திரம்", "machine"),
    ("கிடங்கு", "warehouse"), ("சேமிப்பு", "storage"),
    ("ஆய்வு", "inspection"), ("சோதனை", "testing"),
    ("இயக்குபவர்", "operator"), ("வெல்டர்", "welder"),
    ("போக்குவரத்து", "transport"), ("கிடைக்கும்", "available"),
    ("சரிபார்க்கப்பட்ட", "verified"), ("பட்ஜெட்", "budget"),
    ("ரூபாய்", "rs"), ("அலகுகள்", "units"), ("நாட்கள்", "days"),
    ("அலுமினியம்", "aluminium"), ("துருப்பிடிக்காத எஃகு", "stainless steel"),
    ("எஃகு", "steel"),
    # Telugu
    ("వచ్చే వారం", "next week"), ("రోజుకు", "per day"),
    ("సిఎన్సి", "cnc"), ("సీఎన్సీ", "cnc"), ("యంత్రం", "machine"),
    ("గిడ్డంగి", "warehouse"), ("నిల్వ", "storage"),
    ("తనిఖీ", "inspection"), ("పరీక్ష", "testing"),
    ("ఆపరేటర్", "operator"), ("వెల్డర్", "welder"), ("రవాణా", "transport"),
    ("అందుబాటులో", "available"), ("ధృవీకరించబడిన", "verified"),
    ("బడ్జెట్", "budget"), ("రూపాయలు", "rs"),
    ("యూనిట్లు", "units"), ("రోజులు", "days"),
    ("అల్యూమినియం", "aluminium"), ("స్టెయిన్లెస్ స్టీల్", "stainless steel"),
    ("ఉక్కు", "steel"), ("స్టీల్", "steel"),
)

SPOKEN_CLUSTER_ALIASES = {
    "Peenya": ("पीण्या", "पीन्या", "பீன்யா", "பீனியா", "పీన్యా"),
    "Coimbatore": ("कोयंबटूर", "कोयम्बटूर", "கோயம்புத்தூர்", "కోయంబత్తూరు"),
    "Chennai": ("चेन्नई", "சென்னை", "చెన్నై"),
    "Hyderabad": ("हैदराबाद", "ஹைதராபாத்", "హైదరాబాద్"),
    "Hosur": ("होसुर", "ஓசூர்", "హోసూరు"),
    "Bhosari": ("भोसरी", "போசரி", "భోసారి"),
    "Sriperumbudur": ("श्रीपेरंबदूर", "ஸ்ரீபெரும்புதூர்", "శ్రీపెరంబుదూర్"),
    "Tiruppur": ("तिरुप्पुर", "திருப்பூர்", "తిరుప్పూర్"),
}

# These compact, domain-specific expansions make the local ranker useful for
# common shop-floor abbreviations without a model download. They feed only the
# subword component; the lexical TF-IDF score remains independently visible.
SEMANTIC_PHRASE_ALIASES = (
    ("computer numerical control", "cnc machining"),
    ("coordinate measuring machine", "cmm inspection testing"),
    ("quality control", "quality inspection testing"),
    ("cold room", "cold storage warehouse"),
    ("five axis", "5 axis cnc machining"),
    ("five-axis", "5 axis cnc machining"),
)

SEMANTIC_TERM_EXPANSIONS = {
    "cnc": ("machining", "vmc", "milling", "turning"),
    "vmc": ("cnc", "machining", "milling"),
    "lathe": ("turning", "machining"),
    "milling": ("mill", "machining", "cnc"),
    "machining": ("cnc", "milling", "turning"),
    "cmm": ("inspection", "testing", "metrology"),
    "metrology": ("cmm", "inspection", "testing"),
    "warehouse": ("storage", "godown"),
    "godown": ("warehouse", "storage"),
    "logistics": ("transport", "truck"),
    "forklift": ("material", "handling", "logistics"),
    "aluminum": ("aluminium",),
    "aluminium": ("aluminum",),
}

COMPOSE_PROMPTS = {
    "search": (
        "find a verified CNC machine in Coimbatore under Rs 5,000/day",
        "show available warehouse space near Peenya",
        "match me with a testing lab in Chennai",
        "find an available forklift in Tiruppur under Rs 3,000/day",
    ),
    "planner": (
        "produce 500 aluminium parts using CNC machining and quality inspection in Peenya within 7 days under Rs 80,000",
        "plan 1,000 stainless steel components with machining and surface finishing in Coimbatore",
        "manufacture 250 brass parts within 5 days under Rs 60,000",
    ),
    "listing": (
        "5-axis CNC machining center in Peenya, available at Rs 7,500/day",
        "climate-controlled warehouse space in Bhosari at Rs 4,000/day",
        "coordinate measuring machine for precision inspection in Chennai",
    ),
}

INTENT_PATTERNS = (
    ("book", re.compile(r"\b(book|reserve|hold|confirm booking)\b")),
    ("plan", re.compile(r"\b(plan|production|chain|process|make|manufacture|produce)\b")),
    ("list", re.compile(r"\b(list|add resource|new listing|publish)\b")),
    ("analytics", re.compile(r"\b(analytic|dashboard|demand|supply|utilization|kpi)\b")),
    ("verify", re.compile(r"\b(verify|approve|reject|pending)\b")),
    ("search", re.compile(r"\b(find|search|match|need|looking|show|available)\b")),
)

PLAYBOOK = [
    {
        "id": "match",
        "q": "How does matching work?",
        "a": "FREP scores capability, capacity, availability, cluster proximity, budget, trust, verification, health, quality, deadline, logistics, and material fit. Rankings are estimated and explainable — not a black box.",
    },
    {
        "id": "book",
        "q": "How do I book a resource?",
        "a": "Use Quick book on a verified available listing, or build a bundle cart for a multi-resource chain. High-value or high-capacity jobs may wait for owner approval.",
    },
    {
        "id": "verify",
        "q": "Why is a listing pending?",
        "a": "New owner listings start unverified. A network admin must approve them before they are treated as trusted capacity on the marketplace.",
    },
    {
        "id": "cluster",
        "q": "What are industrial clusters?",
        "a": "FREP ships a directory of 25 Indian MSME hubs. Filter by cluster to keep machining, storage, inspection, and logistics closer together and reduce transport time.",
    },
    {
        "id": "cost",
        "q": "Buy vs outsource vs FREP?",
        "a": "The planner compares estimated CAPEX of buying machines, typical job-shop outsourcing, and a FREP shared-capacity chain. Figures are demo estimates, not quotes.",
    },
]


def engine_status():
    groq = bool(os.environ.get("GROQ_API_KEY") or os.environ.get("FREP_GROQ_API_KEY"))
    gemini = bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or os.environ.get("FREP_GEMINI_API_KEY"))
    if groq:
        mode = "hybrid-groq"
        label = "Groq Llama (free tier) + local retrieval"
    elif gemini:
        mode = "hybrid-gemini"
        label = "Gemini Flash (free tier) + local retrieval"
    else:
        mode = "local"
        label = "FREP Local Intelligence (on-device, no API key)"
    return {
        "mode": mode,
        "label": label,
        "paid": False,
        "cloudEnabled": groq or gemini,
        "capabilities": [
            "natural-language search",
            "intent classification",
            "entity extraction",
            "hybrid TF-IDF + subword semantic ranking",
            "production requirement parsing",
            "confidence-scored live composition",
            "retrieval-augmented copilot",
        ],
        "semanticRanker": {
            "id": SEMANTIC_RANKER,
            "localOnly": True,
            "modelDownloadRequired": False,
            "fallback": "lexical-tfidf",
        },
    }


def _normalize_multilingual_domain_text(text):
    """Map a small multilingual manufacturing vocabulary into local English terms."""
    normalized = str(text or "").lower().replace("\u200c", "").replace("\u200d", "")
    for alias, replacement in MULTILINGUAL_DOMAIN_ALIASES:
        comparable_alias = alias.lower().replace("\u200c", "").replace("\u200d", "")
        if comparable_alias in normalized:
            normalized = normalized.replace(comparable_alias, f" {replacement} ")
    return " ".join(normalized.split())


def tokenize(text):
    normalized = _normalize_multilingual_domain_text(text)
    return [tok for tok in TOKEN_RE.findall(normalized) if tok not in STOPWORDS and len(tok) > 1]


def _idf(docs):
    df = Counter()
    for tokens in docs:
        df.update(set(tokens))
    n = max(1, len(docs))
    return {term: math.log((n + 1) / (count + 1)) + 1.0 for term, count in df.items()}


def _tfidf(tokens, idf):
    tf = Counter(tokens)
    length = max(1, len(tokens))
    return {term: (count / length) * idf.get(term, 0.0) for term, count in tf.items()}


def _stable_bucket(value, buckets=SUBWORD_BUCKETS):
    """Return a deterministic FNV-1a bucket (unlike Python's salted hash)."""
    digest = 2166136261
    for byte in value.encode("utf-8"):
        digest ^= byte
        digest = (digest * 16777619) & 0xFFFFFFFF
    return digest % buckets


def _semantic_terms(text):
    normalized = _normalize_multilingual_domain_text(text)
    for phrase, replacement in SEMANTIC_PHRASE_ALIASES:
        normalized = normalized.replace(phrase, replacement)
    terms = tokenize(normalized)
    expanded = []
    for term in terms:
        expanded.append(term)
        expanded.extend(SEMANTIC_TERM_EXPANSIONS.get(term, ()))
    return expanded


def _subword_features(text):
    """Build a small sparse bag of stable hashed character/subword features."""
    features = []
    for term in _semantic_terms(text):
        padded = f"^{term}$"
        term_features = set()
        # Whole short terms retain useful acronyms such as CNC, CMM and VMC.
        if len(term) <= 4:
            term_features.add(f"w:{_stable_bucket(term)}")
        for width in (3, 4, 5):
            if len(padded) < width:
                continue
            for start in range(len(padded) - width + 1):
                gram = f"{width}:{padded[start:start + width]}"
                term_features.add(f"s:{_stable_bucket(gram)}")
        features.extend(term_features)
    return features


def cosine(vec_a, vec_b):
    if not vec_a or not vec_b:
        return 0.0
    dot = sum(vec_a.get(term, 0.0) * weight for term, weight in vec_b.items())
    norm_a = math.sqrt(sum(v * v for v in vec_a.values()))
    norm_b = math.sqrt(sum(v * v for v in vec_b.values()))
    if not norm_a or not norm_b:
        return 0.0
    return dot / (norm_a * norm_b)


def resource_document(resource):
    parts = [
        resource.get("name"),
        resource.get("category"),
        resource.get("cluster"),
        resource.get("description"),
        resource.get("ownerName"),
        " ".join(resource.get("tags") or []),
        " ".join(resource.get("capabilities") or []),
    ]
    return " ".join(str(part or "") for part in parts)


def semantic_rank(query_text, resources, limit=8):
    query_tokens = tokenize(query_text)
    if not query_tokens or not resources:
        return []
    documents = [resource_document(item) for item in resources]
    docs = [tokenize(document) for document in documents]
    lexical_idf = _idf([query_tokens] + docs)
    query_vec = _tfidf(query_tokens, lexical_idf)

    # Character n-grams recover useful matches for misspellings, inflections,
    # abbreviations and Indian manufacturing vocabulary. If that enhancement
    # ever cannot be built, ranking explicitly falls back to the old TF-IDF
    # path rather than making search depend on a model or network call.
    subword_error = None
    try:
        query_subwords = _subword_features(query_text)
        doc_subwords = [_subword_features(document) for document in documents]
        subword_idf = _idf([query_subwords] + doc_subwords)
        query_subword_vec = _tfidf(query_subwords, subword_idf)
    except (MemoryError, TypeError, ValueError) as exc:
        query_subwords = []
        doc_subwords = [[] for _ in documents]
        subword_idf = {}
        query_subword_vec = {}
        subword_error = type(exc).__name__

    ranked = []
    for resource, tokens, subwords in zip(resources, docs, doc_subwords):
        lexical_score = cosine(query_vec, _tfidf(tokens, lexical_idf))
        subword_score = cosine(query_subword_vec, _tfidf(subwords, subword_idf))
        if query_subword_vec and subwords:
            lexical_weight, subword_weight = 0.62, 0.38
            score = lexical_score * lexical_weight + subword_score * subword_weight
            fallback = None
        else:
            lexical_weight, subword_weight = 1.0, 0.0
            score = lexical_score
            fallback = "lexical-tfidf"
        metadata = {
            "method": SEMANTIC_RANKER if not fallback else "tfidf-v1",
            "localOnly": True,
            "lexicalScore": round(lexical_score, 4),
            "subwordScore": round(subword_score, 4),
            "weights": {
                "lexical": lexical_weight,
                "subword": subword_weight,
            },
            "fallback": fallback,
        }
        if subword_error:
            metadata["fallbackReason"] = subword_error
        ranked.append((score, resource, metadata))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return [
        {"score": round(score, 4), "resource": resource, "metadata": metadata}
        for score, resource, metadata in ranked[:limit]
        if score > 0
    ]


def _cluster_from_text(text, clusters):
    lower = str(text or "").lower().replace("\u200c", "").replace("\u200d", "")
    for cluster in clusters:
        name = cluster.get("name") if isinstance(cluster, dict) else str(cluster)
        if name and name.lower() in lower:
            return name
        for canonical, aliases in SPOKEN_CLUSTER_ALIASES.items():
            if name and name.lower() == canonical.lower() and any(
                alias.lower().replace("\u200c", "").replace("\u200d", "") in lower
                for alias in aliases
            ):
                return name
        if isinstance(cluster, dict):
            for key in ("city", "state"):
                value = cluster.get(key) or ""
                if len(value) > 3 and value.lower() in lower:
                    return name
    return ""


def _contains_domain_term(text, term):
    """Match a normalized domain word without accidental inner substrings."""
    return bool(re.search(rf"(?<!\w){re.escape(term)}(?!\w)", text, re.UNICODE))


def _category_from_text(text):
    lower = _normalize_multilingual_domain_text(text)
    # Prefer explicit domain terms over the generic word "machine" so a CMM
    # inspection machine is classified as testing equipment, not a CNC asset.
    category_groups = (
        (("cnc", "lathe", "mill", "vmc", "press"), "Machinery"),
        (("cmm", "inspect", "inspection", "testing", "lab", "laboratory"), "Testing Equipment"),
        (("warehouse", "storage", "cold"), "Warehouse Space"),
        (("operator", "manpower", "welder"), "Skilled Operator"),
        (("truck", "logistic", "logistics", "forklift", "transport"), "Logistics Vehicle"),
        (("machine",), "Machinery"),
    )
    for aliases, category in category_groups:
        if any(_contains_domain_term(lower, alias) for alias in aliases):
            return category
    return ""


def extract_entities(text, clusters=None):
    raw = text or ""
    normalized = _normalize_multilingual_domain_text(raw)
    numbers = [int(value) for value in re.findall(r"\d+", normalized.replace(",", ""))]
    budget = None
    quantity = None
    deadline_days = None
    if re.search(r"₹|rs\.?|rupee|budget|price|/day|per\s+day", normalized, re.I):
        budget = max(numbers) if numbers else None
    if re.search(r"\b(qty|quantity|units?|pcs|pieces)\b", normalized, re.I) and numbers:
        quantity = numbers[0]
    days_match = re.search(r"(\d+)\s*(day|days)", normalized, re.I)
    if days_match:
        deadline_days = int(days_match.group(1))
    if budget is None and numbers and max(numbers) >= 1000:
        budget = max(numbers)
    if quantity is None and numbers and min(numbers) < 1000:
        quantity = min(numbers)
    return {
        "cluster": _cluster_from_text(raw, clusters or []),
        "category": _category_from_text(normalized),
        "budget": budget,
        "quantity": quantity,
        "deadlineDays": deadline_days,
        "material": _extract_material(normalized),
        "processes": infer_capabilities_from_text(normalized),
        "verifiedOnly": bool(re.search(r"\bverified\b", normalized, re.I)),
        "availableOnly": bool(re.search(r"\bavailable\b", normalized, re.I)),
    }


def _extract_material(text):
    lower = _normalize_multilingual_domain_text(text)
    for key, label in MATERIAL_ALIASES.items():
        if key in lower:
            return label
    return ""


def infer_capabilities_from_text(text):
    lower = _normalize_multilingual_domain_text(text)
    found = []
    for tokens, label in PROCESS_MAP:
        if any(_contains_domain_term(lower, token) for token in tokens):
            found.append(label)
    return found


def extract_partial_fields(text, clusters=None, source="search"):
    """Extract only values actually present in unfinished Compose text.

    Unlike :func:`parse_requirement`, this function deliberately supplies no
    planner defaults.  That distinction prevents a debounce response from
    filling fields the user never mentioned.
    """
    raw = str(text or "")
    normalized_raw = _normalize_multilingual_domain_text(raw)
    lower = normalized_raw.lower()
    source = str(source or "search").strip().lower()
    fields = {}

    def add(key, value, confidence):
        if value not in (None, "", []):
            fields[key] = {
                "value": value,
                "confidence": round(max(0.0, min(1.0, float(confidence))), 2),
            }

    material = _extract_material(normalized_raw)
    if material:
        add("material", material, 0.96)

    cluster_name = _cluster_from_text(raw, clusters or [])
    if cluster_name:
        # An exact hub mention is safer to auto-fill than a city/state alias.
        exact_hub = bool(re.search(rf"\b{re.escape(cluster_name)}\b", raw, re.I))
        add("cluster", cluster_name, 0.98 if exact_hub else 0.86)

    category = _category_from_text(normalized_raw)
    if category:
        add("category", category, 0.91)

    processes = infer_capabilities_from_text(normalized_raw)
    if processes:
        add("processes", ", ".join(processes), 0.9)

    quantity_match = re.search(
        r"\b(?:qty|quantity)\s*(?:of|:|=)?\s*([0-9][0-9,]*)\b|"
        r"\b([0-9][0-9,]*)\s*(?:units?|pcs?|pieces?|components?|parts?)\b|"
        r"\b(?:produce|make|manufacture|plan(?:\s+for)?|need)\s+"
        r"([0-9][0-9,]*)\s+(?!days?\b|weeks?\b|(?:/|per\s+)day\b)",
        normalized_raw,
        re.I,
    )
    if quantity_match:
        quantity_text = quantity_match.group(1) or quantity_match.group(2) or quantity_match.group(3)
        add("quantity", int(quantity_text.replace(",", "")), 0.97)

    deadline_match = re.search(
        r"\b(?:within|in|deadline(?:\s+of)?|by)\s*([0-9]{1,3})\s*days?\b|"
        r"\b([0-9]{1,3})\s*day\s*(?:deadline|turnaround)\b|"
        r"\bfor\s*([0-9]{1,3})\s*days?\b",
        normalized_raw,
        re.I,
    )
    if deadline_match:
        add(
            "deadline",
            int(deadline_match.group(1) or deadline_match.group(2) or deadline_match.group(3)),
            0.95,
        )
    elif re.search(r"\bnext\s+week\b", normalized_raw, re.I):
        add("deadline", 7, 0.8)
    elif re.search(r"\btomorrow\b", normalized_raw, re.I):
        add("deadline", 1, 0.85)

    money_pattern = (
        r"(?:\u20b9|rs\.?|inr)\s*([0-9][0-9,]*)|"
        r"\b(?:budget(?:\s+of)?|under|below|max(?:imum)?|up\s+to)\s*"
        r"(?:\u20b9|rs\.?|inr)?\s*([0-9][0-9,]*)|"
        r"\b([0-9][0-9,]*)\s*(?:\u20b9|rs\.?|inr)\b"
    )
    money_match = re.search(money_pattern, normalized_raw, re.I)
    if not money_match and source == "listing":
        money_match = re.search(
            r"\b(?:at|for)\s*([0-9][0-9,]*)\s*(?:/|per\s+)day\b",
            normalized_raw,
            re.I,
        )
    if money_match:
        amount_text = next((group for group in money_match.groups() if group), None)
        amount = int(amount_text.replace(",", ""))
        per_day = bool(re.search(r"(?:/|per\s+)day\b", normalized_raw[money_match.start():], re.I))
        if source == "listing" and per_day:
            add("pricePerDay", amount, 0.96)
        else:
            add("budget", amount, 0.94 if per_day or "budget" in lower else 0.88)

    if re.search(r"\bverified\b", normalized_raw, re.I):
        add("verifiedOnly", True, 0.99)
    if re.search(r"\bavailable(?:\s+now)?\b", normalized_raw, re.I):
        add("availableOnly", True, 0.97)

    if source == "listing":
        listing_phrase = re.sub(
            r"^\s*(?:please\s+)?(?:list|add|publish|offer)\s+(?:an?\s+|the\s+)?",
            "",
            raw,
            flags=re.I,
        ).strip(" ,.-")
        name_candidate = re.split(
            r"\s+(?:in|near|at|for|with|available\b)\s+",
            listing_phrase,
            maxsplit=1,
            flags=re.I,
        )[0].strip(" ,.-")
        if 3 <= len(name_candidate) <= 90 and re.search(r"[a-z]", name_candidate, re.I):
            add("name", name_candidate, 0.84)
        if 8 <= len(listing_phrase) <= 300:
            add("description", listing_phrase, 0.68)

    return fields


def contextual_completion(text, role="buyer", context=None, clusters=None):
    """Return a short suffix for ghost text using only local rules.

    The return value is a suffix, not a replacement for ``text``.  The caller
    can append it on Tab/Right Arrow without moving or rewriting the user's
    existing input.
    """
    raw = str(text or "")
    typed = raw.lstrip()
    if not typed.strip():
        return ""
    context = context if isinstance(context, dict) else {}
    source = str(context.get("source") or ("listing" if role == "owner" else "search")).lower()
    if source not in COMPOSE_PROMPTS:
        source = "listing" if role == "owner" else "search"

    lowered = typed.lower()
    for candidate in COMPOSE_PROMPTS[source]:
        if candidate.lower().startswith(lowered) and len(candidate) > len(typed):
            return candidate[len(typed):][:120]

    # Finish a partial procurement word before offering a phrase continuation.
    word_match = re.search(r"([a-z]{2,})$", lowered)
    if word_match:
        partial = word_match.group(1)
        vocabulary = (
            "available", "verified", "machining", "machine", "warehouse",
            "inspection", "aluminium", "stainless", "Coimbatore", "Peenya",
            "Tiruppur", "Chennai", "budget", "components", "production",
        )
        for word in vocabulary:
            if word.lower().startswith(partial) and word.lower() != partial:
                return word[len(partial):]

    observed = extract_partial_fields(raw, clusters or [], source)
    cluster = observed.get("cluster", {}).get("value")
    category = observed.get("category", {}).get("value")
    has_budget = "budget" in observed or "pricePerDay" in observed
    form = context.get("form") if isinstance(context.get("form"), dict) else {}
    context_cluster = context.get("cluster") or form.get("cluster")
    directory_names = [
        item.get("name") if isinstance(item, dict) else str(item)
        for item in (clusters or [])
    ]
    directory_names = [name for name in directory_names if name]
    suggested_cluster = context_cluster if context_cluster in directory_names else (directory_names[0] if directory_names else "")
    if source == "planner":
        if "quantity" not in observed:
            return " for 500 units"
        if not cluster and suggested_cluster:
            return f" in {suggested_cluster}"
        if "deadline" not in observed:
            return " within 7 days"
        if not has_budget:
            return " under Rs 80,000"
    elif source == "listing":
        if not cluster and suggested_cluster:
            return f" in {suggested_cluster}"
        if not has_budget:
            return ", available at Rs 5,000/day"
    else:
        if category and not cluster and suggested_cluster:
            return f" in {suggested_cluster}"
        if not has_budget:
            return " under Rs 5,000/day"
        if "availableOnly" not in observed:
            return " available now"
    return ""


def classify_intent(text):
    lower = (text or "").lower()
    for intent, pattern in INTENT_PATTERNS:
        if pattern.search(lower):
            return intent
    if "?" in (text or ""):
        return "help"
    return "search"


def parse_requirement(text, clusters=None):
    entities = extract_entities(text, clusters)
    processes = entities["processes"] or ["CNC Machining", "Quality Inspection"]
    return {
        "productName": "NL requirement",
        "quantity": entities["quantity"] or 500,
        "material": entities["material"] or "Aluminium",
        "processes": ", ".join(processes),
        "deadline": entities["deadlineDays"] or 7,
        "budget": entities["budget"] or 80000,
        "cluster": entities["cluster"],
        "quality": "High" if re.search(r"high|precision|tight", text or "", re.I) else "Standard",
        "entities": entities,
        "intent": classify_intent(text),
    }


def _playbook_hit(text):
    tokens = set(tokenize(text))
    best = None
    best_score = 0
    for item in PLAYBOOK:
        overlap = len(tokens & set(tokenize(item["q"] + " " + item["a"])))
        if overlap > best_score:
            best = item
            best_score = overlap
    return best if best_score >= 2 else None


def _format_local_reply(intent, entities, matches, playbook):
    if playbook and intent in {"help", "analytics", "verify"}:
        return playbook["a"]
    if intent == "plan":
        cluster = entities.get("cluster") or "your preferred cluster"
        processes = ", ".join(entities.get("processes") or ["CNC Machining"])
        return (
            f"I parsed a production job: {entities.get('quantity') or 500} units"
            f"{' in ' + entities['material'] if entities.get('material') else ''}, "
            f"processes {processes}, around {cluster}. Open the planner to build a shared-capacity chain."
        )
    if intent == "book":
        if matches:
            top = matches[0]["resource"]
            return f"Best bookable match is {top.get('name')} in {top.get('cluster')} at ₹{top.get('pricePerDay')}/day. I can queue a quick book from the results."
        return "Tell me the resource type and cluster, for example: book a verified CNC in Peenya under ₹5000/day."
    if matches:
        lines = []
        for item in matches[:3]:
            resource = item["resource"]
            lines.append(
                f"{resource.get('name')} · {resource.get('cluster')} · ₹{resource.get('pricePerDay')}/day · semantic {int(item['score'] * 100)}%"
            )
        hint = f" in {entities['cluster']}" if entities.get("cluster") else ""
        return "Top semantic matches" + hint + ":\n" + "\n".join(lines)
    return "I can search capacity, plan a production chain, or explain verification. Try: need a verified CNC lathe in Coimbatore under 6000 for 3 days."


def _optional_cloud_complete(prompt, context):
    groq_key = os.environ.get("GROQ_API_KEY") or os.environ.get("FREP_GROQ_API_KEY")
    gemini_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or os.environ.get("FREP_GEMINI_API_KEY")
    system = (
        "You are FREP Copilot, a factory resource exchange assistant for Indian MSMEs. "
        "Use only the provided catalogue context. Be concise. Never invent listings. "
        "Mark estimates as estimated. If data is missing, say so."
    )
    user = f"Context:\n{context}\n\nUser: {prompt}"
    if groq_key:
        body = {
            "model": os.environ.get("FREP_GROQ_MODEL", "llama-3.1-8b-instant"),
            "temperature": 0.2,
            "max_tokens": 280,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        req = urllib.request.Request(
            "https://api.groq.com/openai/v1/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {groq_key}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        return payload["choices"][0]["message"]["content"].strip(), "hybrid-groq"
    if gemini_key:
        body = {
            "contents": [{"parts": [{"text": system + "\n\n" + user}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 280},
        }
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{os.environ.get('FREP_GEMINI_MODEL', 'gemini-2.0-flash')}:generateContent?key={gemini_key}"
        )
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        text = payload["candidates"][0]["content"]["parts"][0]["text"].strip()
        return text, "hybrid-gemini"
    return None, None


def stream_compose_completion(text, source, fields, matches):
    """Return an optional free-tier cloud token iterator and its engine name.

    Compose always renders its deterministic/browser-local result first.  This
    iterator is only requested when a user supplied a provider key and can fail
    independently without affecting that guaranteed path.
    """
    groq_key = os.environ.get("GROQ_API_KEY") or os.environ.get("FREP_GROQ_API_KEY")
    gemini_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or os.environ.get("FREP_GEMINI_API_KEY")
    if not groq_key and not gemini_key:
        return None, None

    observed = {
        key: value.get("value") if isinstance(value, dict) else value
        for key, value in (fields or {}).items()
    }
    catalogue = [
        {
            "id": item.get("id"),
            "name": item.get("name"),
            "category": item.get("category"),
            "cluster": item.get("cluster"),
            "pricePerDay": item.get("pricePerDay"),
            "available": item.get("availability"),
            "verified": item.get("verified"),
        }
        for item in (matches or [])[:3]
    ]
    system = (
        "You are FREP Compose for an Indian factory-capacity marketplace. "
        "Complete the unfinished input with one short procurement-relevant continuation. "
        "Return continuation text only: no quotes, markdown, explanation, or repeated input. "
        "Use only observed fields and catalogue facts; never invent a listing or submit an action."
    )
    user = (
        f"Workflow: {source}\n"
        f"Observed fields: {json.dumps(observed, ensure_ascii=False)}\n"
        f"Grounded matches: {json.dumps(catalogue, ensure_ascii=False)}\n"
        f"Unfinished input: {text}\n"
        "Continuation:"
    )

    def sse_payloads(response):
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                if data == "[DONE]":
                    break
                continue
            yield json.loads(data)

    if groq_key:
        body = {
            "model": os.environ.get("FREP_GROQ_MODEL", "llama-3.1-8b-instant"),
            "temperature": 0.15,
            "max_tokens": 64,
            "stream": True,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }

        def groq_chunks():
            request = urllib.request.Request(
                "https://api.groq.com/openai/v1/chat/completions",
                data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {groq_key}"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=8) as response:
                for payload in sse_payloads(response):
                    token = payload.get("choices", [{}])[0].get("delta", {}).get("content")
                    if token:
                        yield token

        return groq_chunks(), "hybrid-groq"

    body = {
        "contents": [{"parts": [{"text": system + "\n\n" + user}]}],
        "generationConfig": {"temperature": 0.15, "maxOutputTokens": 64},
    }
    model = os.environ.get("FREP_GEMINI_MODEL", "gemini-2.0-flash")

    def gemini_chunks():
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:streamGenerateContent?alt=sse&key={gemini_key}"
        )
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            for payload in sse_payloads(response):
                candidates = payload.get("candidates") or []
                parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
                token = "".join(part.get("text", "") for part in parts)
                if token:
                    yield token

    return gemini_chunks(), "hybrid-gemini"


def answer_query(message, resources, clusters=None, extra_context=None):
    text = (message or "").strip()
    status = engine_status()
    if not text:
        return {
            "ok": True,
            "engine": status,
            "intent": "help",
            "entities": {},
            "reply": "Ask me to find capacity, plan a job, or explain FREP workflows.",
            "matches": [],
            "actions": [],
            "createdAt": datetime.now().replace(microsecond=0).isoformat(),
        }

    entities = extract_entities(text, clusters or [])
    intent = classify_intent(text)
    filtered = resources
    if entities.get("cluster"):
        cluster = entities["cluster"].lower()
        filtered = [item for item in filtered if cluster in (item.get("cluster") or "").lower()] or filtered
    if entities.get("category"):
        category = entities["category"]
        category_hits = [item for item in filtered if item.get("category") == category]
        filtered = category_hits or filtered
    if entities.get("budget"):
        budget_hits = [item for item in filtered if (item.get("pricePerDay") or 0) <= entities["budget"]]
        filtered = budget_hits or filtered
    if entities.get("verifiedOnly"):
        filtered = [item for item in filtered if item.get("verified")] or filtered
    if entities.get("availableOnly"):
        filtered = [item for item in filtered if item.get("availability")] or filtered

    matches = semantic_rank(text, filtered, limit=6)
    playbook = _playbook_hit(text)
    local_reply = _format_local_reply(intent, entities, matches, playbook)
    context_lines = [
        extra_context or "",
        "Catalogue:",
        *[
            f"- {item['resource'].get('id')} {item['resource'].get('name')} | {item['resource'].get('category')} | {item['resource'].get('cluster')} | ₹{item['resource'].get('pricePerDay')}/day | verified={item['resource'].get('verified')} | available={item['resource'].get('availability')}"
            for item in matches[:5]
        ],
    ]
    reply = local_reply
    mode = status["mode"]
    try:
        cloud_reply, cloud_mode = _optional_cloud_complete(text, "\n".join(context_lines))
        if cloud_reply:
            reply = cloud_reply
            mode = cloud_mode
            status = {**status, "mode": mode, "label": engine_status()["label"]}
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, KeyError, IndexError, json.JSONDecodeError, OSError):
        reply = local_reply
        mode = "local-fallback"

    actions = []
    if intent == "search" or matches:
        actions.append({
            "type": "set_filters",
            "filters": {
                "cluster": entities.get("cluster") or "",
                "resourceType": entities.get("category") or "",
                "budget": entities.get("budget") or "",
                "verifiedOnly": bool(entities.get("verifiedOnly")),
                "availableOnly": bool(entities.get("availableOnly")),
                "search": text[:80],
            },
        })
    if intent == "plan":
        parsed = parse_requirement(text, clusters)
        actions.append({"type": "open_planner", "payload": parsed})
    if intent == "analytics":
        actions.append({"type": "open_view", "view": "analytics"})
    if intent == "verify":
        actions.append({"type": "open_view", "view": "admin"})
    if intent == "list":
        actions.append({"type": "open_view", "view": "listings"})

    return {
        "ok": True,
        "engine": {**status, "mode": mode},
        "intent": intent,
        "entities": entities,
        "reply": reply,
        "matches": [
            {
                "id": item["resource"].get("id"),
                "name": item["resource"].get("name"),
                "category": item["resource"].get("category"),
                "cluster": item["resource"].get("cluster"),
                "pricePerDay": item["resource"].get("pricePerDay"),
                "verified": item["resource"].get("verified"),
                "availability": item["resource"].get("availability"),
                "semanticScore": round(item["score"] * 100),
            }
            for item in matches
        ],
        "actions": actions,
        "createdAt": datetime.now().replace(microsecond=0).isoformat(),
    }
