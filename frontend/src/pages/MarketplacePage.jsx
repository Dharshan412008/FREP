import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Factory,
  Gauge,
  IndianRupee,
  MapPin,
  Mic,
  MicOff,
  PackageCheck,
  Radar,
  RotateCcw,
  Search,
  ShieldCheck,
  ShoppingBasket,
  Sparkles,
  Star,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { getTypeahead, matchResources } from "../lib/api.js";

const DEFAULT_FILTERS = {
  resourceType: "",
  cluster: "",
  budget: "",
  deadline: "",
  verifiedOnly: false,
  availableOnly: true,
  sort: "score",
};

const VOICE_LANGUAGES = [
  { value: "en-IN", label: "English" },
  { value: "hi-IN", label: "हिन्दी" },
  { value: "ta-IN", label: "தமிழ்" },
  { value: "te-IN", label: "తెలుగు" },
];

const money = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
});

function clusterName(cluster) {
  return typeof cluster === "string" ? cluster : cluster?.name || cluster?.city || "";
}

function fieldValue(field) {
  return field && typeof field === "object" && "value" in field ? field.value : field;
}

function resourceScore(resource) {
  return Math.max(
    0,
    Math.min(
      100,
      Number(
        resource?.match?.score ??
          resource?.score ??
          resource?.semanticScore ??
          resource?.matchScore ??
          0,
      ) || 0,
    ),
  );
}

function resourceExplanation(resource) {
  const match = resource?.match || {};
  const explanation = resource?.explanation || match.explanation || {};
  return (
    resource?.why ||
    match.why ||
    (typeof explanation === "string" ? explanation : explanation?.why) ||
    "Ranked using capability, location, cost, availability, verification and trust signals."
  );
}

function factorRows(resource) {
  const match = resource?.match || {};
  const contributions = match.contributions || resource?.contributions;
  const weights = match.weights || resource?.weights || {};
  if (contributions && typeof contributions === "object") {
    return Object.entries(contributions).map(([name, contribution]) => ({
      name,
      contribution,
      weight: weights[name],
    }));
  }

  const breakdown =
    match.breakdown ||
    (typeof resource?.explanation === "object" ? resource.explanation.breakdown : null) ||
    resource?.breakdown ||
    {};
  return Object.entries(breakdown)
    .filter(([name]) => name !== "blendedScore")
    .map(([name, value]) => ({
      name,
      contribution:
        value && typeof value === "object"
          ? value.contribution ?? value.score ?? value.value
          : value,
      weight: value && typeof value === "object" ? value.weight : undefined,
    }));
}

function humanize(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatFactor(value, weight) {
  const numeric = Number(value);
  const normalized = Number.isFinite(numeric)
    ? `${Math.round((numeric <= 1 ? numeric * 100 : numeric) * 10) / 10}${
        numeric <= 1 ? "%" : " pts"
      }`
    : String(value ?? "—");
  const numericWeight = Number(weight);
  if (!Number.isFinite(numericWeight)) return normalized;
  return `${normalized} · ${Math.round(numericWeight <= 1 ? numericWeight * 100 : numericWeight)}% weight`;
}

function locallyMatches(resource, query, filters) {
  const haystack = [
    resource.name,
    resource.category,
    resource.cluster,
    resource.description,
    ...(resource.tags || []),
    ...(resource.capabilities || []),
  ]
    .join(" ")
    .toLowerCase();
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 2);
  const matchesQuery = !words.length || words.some((word) => haystack.includes(word));
  const matchesType =
    !filters.resourceType ||
    String(resource.category || "").toLowerCase() === filters.resourceType.toLowerCase() ||
    String(resource.name || "").toLowerCase().includes(filters.resourceType.toLowerCase());
  const matchesCluster =
    !filters.cluster ||
    String(resource.cluster || "").toLowerCase().includes(filters.cluster.toLowerCase());
  const matchesBudget =
    filters.budget === "" || Number(resource.pricePerDay || 0) <= Number(filters.budget);
  return (
    matchesQuery &&
    matchesType &&
    matchesCluster &&
    matchesBudget &&
    (!filters.verifiedOnly || resource.verified) &&
    (!filters.availableOnly || resource.availability)
  );
}

function ResourceCard({ resource, inCart, canBook, onToggleCart, onQuickBook }) {
  const score = resourceScore(resource);
  const factors = factorRows(resource);
  const bookable = Boolean(resource.verified && resource.availability);

  return (
    <article className="resource-card">
      <div className="resource-card__topline">
        <div className="resource-card__eyebrow">
          <Factory size={15} aria-hidden="true" />
          <span>{resource.category || "Industrial capacity"}</span>
        </div>
        <span
          className={`status-chip ${resource.verified ? "status-chip--verified" : "status-chip--pending"}`}
        >
          {resource.verified ? <ShieldCheck size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
          {resource.verified ? "Verified" : "Verification pending"}
        </span>
      </div>

      <div className="resource-card__heading">
        <div>
          <h3>{resource.name || "Untitled resource"}</h3>
          <p className="resource-card__location">
            <MapPin size={15} aria-hidden="true" />
            {resource.cluster || "FREP network"}
          </p>
        </div>
        {score > 0 ? (
          <div className="match-orb" aria-label={`${Math.round(score)} percent match`}>
            <strong>{Math.round(score)}</strong>
            <span>% match</span>
          </div>
        ) : null}
      </div>

      {resource.description ? <p className="resource-card__description">{resource.description}</p> : null}

      <div className="resource-card__signals" aria-label="Resource signals">
        <span>
          <Star size={15} aria-hidden="true" />
          {resource.rating ?? "New"}
        </span>
        <span>
          <Gauge size={15} aria-hidden="true" />
          Trust {resource.trustScore ?? "—"}
        </span>
        <span className={resource.availability ? "is-positive" : "is-muted"}>
          <PackageCheck size={15} aria-hidden="true" />
          {resource.availability ? "Available now" : "Unavailable"}
        </span>
      </div>

      {resource.capabilities?.length || resource.tags?.length ? (
        <ul className="tag-list" aria-label="Capabilities">
          {(resource.capabilities?.length ? resource.capabilities : resource.tags || [])
            .slice(0, 4)
            .map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
        </ul>
      ) : null}

      {score > 0 ? (
        <div className="score-panel">
          <div className="score-panel__track" aria-hidden="true">
            <span style={{ width: `${score}%` }} />
          </div>
          <p>
            <Sparkles size={15} aria-hidden="true" />
            <span><strong>Why this match:</strong> {resourceExplanation(resource)}</span>
          </p>
          {factors.length ? (
            <details className="factor-details">
              <summary>
                Inspect score factors <ChevronDown size={15} aria-hidden="true" />
              </summary>
              <dl>
                {factors.slice(0, 8).map((factor) => (
                  <div key={factor.name}>
                    <dt>{humanize(factor.name)}</dt>
                    <dd>{formatFactor(factor.contribution, factor.weight)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </div>
      ) : null}

      <footer className="resource-card__footer">
        <div className="resource-price">
          <span>From</span>
          <strong>
            <IndianRupee size={18} aria-hidden="true" />
            {money.format(Number(resource.pricePerDay || 0))}
          </strong>
          <span>/ day</span>
        </div>
        <div className="resource-card__actions">
          <button
            className={`btn btn--secondary btn--icon-leading ${inCart ? "is-selected" : ""}`}
            type="button"
            onClick={() => onToggleCart(resource.id)}
            disabled={!canBook || !bookable}
            aria-pressed={inCart}
            title={!canBook ? "Booking is available to buyer accounts" : undefined}
          >
            {inCart ? <Check size={17} aria-hidden="true" /> : <ShoppingBasket size={17} aria-hidden="true" />}
            {!canBook ? "Buyer access only" : inCart ? "In bundle" : "Add to bundle"}
          </button>
          <button
            className="btn btn--primary btn--icon-leading"
            type="button"
            onClick={() => onQuickBook(resource)}
            disabled={!canBook || !bookable}
            title={!canBook ? "Booking is available to buyer accounts" : undefined}
          >
            {!canBook ? "Browse only" : bookable ? "Quick book" : resource.verified ? "Unavailable" : "Not verified"}
            {canBook && bookable ? <ArrowRight size={17} aria-hidden="true" /> : null}
          </button>
        </div>
      </footer>
    </article>
  );
}

export default function MarketplacePage({
  resources = [],
  clusters = [],
  cart = [],
  userRole = "buyer",
  navigationIntent = null,
  onToggleCart,
  onBook,
  onToast,
}) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [serverResults, setServerResults] = useState(null);
  const [engineLabel, setEngineLabel] = useState("FREP catalogue");
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState("");
  const [compose, setCompose] = useState(null);
  const [composeLoading, setComposeLoading] = useState(false);
  const [composeError, setComposeError] = useState("");
  const [voiceLanguage, setVoiceLanguage] = useState("en-IN");
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const voiceBaseRef = useRef("");
  const queryRef = useRef(query);
  const canBook = userRole === "buyer";
  const composeEnabled = userRole === "buyer" || userRole === "owner";

  const cartIds = useMemo(
    () => cart.map((item) => (typeof item === "object" ? item.id : item)).filter(Boolean),
    [cart],
  );
  const cartIdSet = useMemo(() => new Set(cartIds), [cartIds]);
  const resourceById = useMemo(
    () => new Map(resources.map((resource) => [resource.id, resource])),
    [resources],
  );
  const cartResources = cartIds.map((id) => resourceById.get(id)).filter(Boolean);
  const cartTotal = cartResources.reduce(
    (total, resource) => total + Number(resource.pricePerDay || 0),
    0,
  );

  const categoryOptions = useMemo(
    () => [...new Set(resources.map((resource) => resource.category).filter(Boolean))].sort(),
    [resources],
  );
  const clusterOptions = useMemo(
    () => [...new Set(clusters.map(clusterName).filter(Boolean))].sort(),
    [clusters],
  );

  const localResults = useMemo(() => {
    const next = resources.filter((resource) => locallyMatches(resource, query, filters));
    return [...next].sort((a, b) => {
      if (filters.sort === "price") return Number(a.pricePerDay || 0) - Number(b.pricePerDay || 0);
      if (filters.sort === "rating") return Number(b.rating || 0) - Number(a.rating || 0);
      return resourceScore(b) - resourceScore(a);
    });
  }, [filters, query, resources]);

  const visibleResults = serverResults ?? localResults;
  const speechSupported =
    typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    if (!navigationIntent?.id) return;
    const incoming = navigationIntent.filters || {};
    const nextFilters = Object.fromEntries(
      Object.entries(incoming).filter(
        ([name, value]) => name in DEFAULT_FILTERS && value !== undefined && value !== null,
      ),
    );
    setFilters({ ...DEFAULT_FILTERS, ...nextFilters });
    setQuery(String(incoming.search || ""));
    setServerResults(null);
    setCompose(null);
    setComposeError("");
    setMatchError("");
  }, [navigationIntent]);

  useEffect(() => {
    if (!composeEnabled || query.trim().length < 3) {
      setCompose(null);
      setComposeError("");
      setComposeLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setComposeLoading(true);
      setComposeError("");
      try {
        const preview = await getTypeahead(
          query,
          {
            source: "search",
            form: {
              ...filters,
              budget: filters.budget === "" ? undefined : Number(filters.budget),
            },
          },
          { signal: controller.signal },
        );
        setCompose(preview);
      } catch (error) {
        if (error?.name !== "AbortError") {
          setCompose(null);
          setComposeError("Live Compose is unavailable; search still works normally.");
        }
      } finally {
        if (!controller.signal.aborted) setComposeLoading(false);
      }
    }, 360);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [composeEnabled, filters.availableOnly, filters.budget, filters.cluster, filters.resourceType, filters.verifiedOnly, query]);

  useEffect(
    () => () => {
      recognitionRef.current?.abort();
    },
    [],
  );

  function updateFilter(name, value) {
    setFilters((current) => ({ ...current, [name]: value }));
    setServerResults(null);
    setMatchError("");
  }

  function updateQuery(value) {
    setQuery(value);
    setServerResults(null);
    setMatchError("");
  }

  async function runMatch(event) {
    event?.preventDefault();
    setMatching(true);
    setMatchError("");
    try {
      const response = await matchResources({
        search: query.trim(),
        resourceType: filters.resourceType,
        cluster: filters.cluster,
        budget: filters.budget === "" ? undefined : Number(filters.budget),
        deadline: filters.deadline,
        verifiedOnly: filters.verifiedOnly,
        availableOnly: filters.availableOnly,
        sort: filters.sort,
      });
      setServerResults(Array.isArray(response?.results) ? response.results : []);
      setEngineLabel(response?.engine?.label || "FREP match engine");
    } catch (error) {
      setServerResults(null);
      setMatchError(error?.message || "The match engine could not be reached.");
      onToast?.("Showing matches from the loaded catalogue.", "warning");
    } finally {
      setMatching(false);
    }
  }

  function resetSearch() {
    setQuery("");
    setFilters(DEFAULT_FILTERS);
    setServerResults(null);
    setCompose(null);
    setComposeError("");
    setMatchError("");
    setEngineLabel("FREP catalogue");
  }

  function acceptCompletion() {
    if (!compose?.completion) return;
    updateQuery(`${query}${compose.completion}`);
  }

  function applyComposeFields() {
    const fields = compose?.fields || {};
    setFilters((current) => ({
      ...current,
      resourceType: fieldValue(fields.category) || current.resourceType,
      cluster: fieldValue(fields.cluster) || current.cluster,
      budget: fieldValue(fields.budget) ?? current.budget,
      deadline: fieldValue(fields.deadline) ?? current.deadline,
      verifiedOnly: fieldValue(fields.verifiedOnly) ?? current.verifiedOnly,
      availableOnly: fieldValue(fields.availableOnly) ?? current.availableOnly,
    }));
    setServerResults(null);
    onToast?.("Observed requirement fields applied.", "success");
  }

  function handleQueryKeyDown(event) {
    if (event.key === "Tab" && compose?.completion) {
      event.preventDefault();
      acceptCompletion();
    }
  }

  function startVoice() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      onToast?.("Voice input is not supported by this browser.", "warning");
      return;
    }
    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognition.lang = voiceLanguage;
    recognition.continuous = true;
    recognition.interimResults = true;
    voiceBaseRef.current = queryRef.current.trim();
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onerror = (event) => {
      setListening(false);
      if (event.error !== "aborted" && event.error !== "no-speech") {
        onToast?.("The microphone could not capture speech. You can keep typing.", "warning");
      }
    };
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript || "")
        .join(" ")
        .trim();
      const next = [voiceBaseRef.current, transcript].filter(Boolean).join(" ");
      updateQuery(next);
    };
    recognitionRef.current = recognition;
    recognition.start();
  }

  function stopVoice() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }

  async function book(resourceIds, label) {
    if (!canBook || !resourceIds.length || !onBook) return;
    try {
      await onBook(resourceIds, label);
    } catch (error) {
      onToast?.(error?.message || "Booking could not be submitted.", "error");
    }
  }

  return (
    <div className={`marketplace-page ${canBook && cartIds.length ? "marketplace-page--has-cart" : ""}`}>
      <section className="page-hero marketplace-hero" aria-labelledby="marketplace-title">
        <div className="page-hero__copy">
          <span className="eyebrow"><Radar size={16} aria-hidden="true" /> Capacity radar</span>
          <h1 id="marketplace-title">Find the missing link in your production line.</h1>
          <p>
            Describe the job in your own words. FREP grounds every result in real network capacity and shows exactly why it ranked.
          </p>
        </div>
        <div className="marketplace-hero__signal" aria-hidden="true">
          <span className="signal-orbit signal-orbit--one" />
          <span className="signal-orbit signal-orbit--two" />
          <span className="signal-core"><Factory /></span>
          <span className="signal-node signal-node--one" />
          <span className="signal-node signal-node--two" />
          <span className="signal-node signal-node--three" />
        </div>
      </section>

      <form className="marketplace-search" onSubmit={runMatch}>
        <div className="marketplace-search__compose">
          <label htmlFor="marketplace-query">What capacity do you need?</label>
          <div className="compose-input-shell">
            <Search size={21} aria-hidden="true" />
            <textarea
              id="marketplace-query"
              rows="2"
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              onKeyDown={handleQueryKeyDown}
              placeholder="Try: Need a verified CNC mill in Peenya below ₹8,000 per day next week"
              aria-describedby="marketplace-compose-status"
            />
            {query ? (
              <button className="icon-btn" type="button" onClick={() => updateQuery("")} aria-label="Clear search text">
                <X size={18} aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <div className="voice-row" aria-label="Voice search controls">
            <div className="voice-language">
              <label htmlFor="marketplace-voice-language">Voice language</label>
              <select
                id="marketplace-voice-language"
                value={voiceLanguage}
                onChange={(event) => setVoiceLanguage(event.target.value)}
                disabled={listening}
              >
                {VOICE_LANGUAGES.map((language) => (
                  <option key={language.value} value={language.value}>{language.label}</option>
                ))}
              </select>
            </div>
            <button
              className={`btn btn--voice ${listening ? "is-listening" : ""}`}
              type="button"
              onClick={listening ? stopVoice : startVoice}
              disabled={!speechSupported}
            >
              {listening ? <MicOff size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
              {listening ? "Stop listening" : "Speak requirement"}
            </button>
            <span className="voice-status" role="status">
              {listening ? "Listening… speak naturally" : speechSupported ? "Your speech stays in the browser" : "Voice is unavailable in this browser"}
            </span>
          </div>

          <div
            className={`compose-preview ${composeLoading ? "is-loading" : ""}`}
            id="marketplace-compose-status"
            aria-live="polite"
          >
            <div className="compose-preview__heading">
              <span><WandSparkles size={16} aria-hidden="true" /> Live Compose</span>
              {compose?.engine?.label ? <small>{compose.engine.label}</small> : null}
            </div>
            {!composeEnabled ? (
              <p className="compose-preview__muted">Live Compose is available to buyer and owner workspaces. Catalogue search remains available here.</p>
            ) : composeLoading ? (
              <p className="skeleton-line">Reading the requirement…</p>
            ) : composeError ? (
              <p className="compose-preview__muted">{composeError}</p>
            ) : compose ? (
              <>
                {compose.completion ? (
                  <button className="completion-chip" type="button" onClick={acceptCompletion}>
                    <span>Press Tab or add</span> “{compose.completion}” <Zap size={14} aria-hidden="true" />
                  </button>
                ) : null}
                {Object.keys(compose.fields || {}).length ? (
                  <div className="compose-preview__fields">
                    <div className="compose-preview__chips">
                      {Object.entries(compose.fields).map(([name, field]) => (
                        <span className="data-chip" key={name}>
                          <small>{humanize(name)}</small>
                          {String(fieldValue(field))}
                          {field?.confidence != null ? <em>{Math.round(field.confidence * 100)}%</em> : null}
                        </span>
                      ))}
                    </div>
                    <button className="btn btn--text" type="button" onClick={applyComposeFields}>
                      Apply observed fields <ArrowRight size={15} aria-hidden="true" />
                    </button>
                  </div>
                ) : (
                  <p className="compose-preview__muted">Add a process, cluster or budget to structure the request.</p>
                )}
              </>
            ) : (
              <p className="compose-preview__muted">Compose will extract filters and preview grounded matches as you type.</p>
            )}
          </div>
        </div>

        <fieldset className="filter-panel">
          <legend>Refine the search</legend>
          <div className="filter-panel__grid">
            <label className="field-control">
              <span>Resource type</span>
              <select value={filters.resourceType} onChange={(event) => updateFilter("resourceType", event.target.value)}>
                <option value="">All capabilities</option>
                {categoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
            </label>
            <label className="field-control">
              <span>Industrial cluster</span>
              <select value={filters.cluster} onChange={(event) => updateFilter("cluster", event.target.value)}>
                <option value="">Across the network</option>
                {clusterOptions.map((cluster) => <option key={cluster} value={cluster}>{cluster}</option>)}
              </select>
            </label>
            <label className="field-control">
              <span>Daily budget</span>
              <div className="input-with-icon">
                <IndianRupee size={16} aria-hidden="true" />
                <input
                  type="number"
                  min="0"
                  step="100"
                  inputMode="numeric"
                  value={filters.budget}
                  onChange={(event) => updateFilter("budget", event.target.value)}
                  placeholder="No limit"
                />
              </div>
            </label>
            <label className="field-control">
              <span>Needed by</span>
              <input type="date" value={filters.deadline} onChange={(event) => updateFilter("deadline", event.target.value)} />
            </label>
            <label className="field-control">
              <span>Sort results</span>
              <select value={filters.sort} onChange={(event) => updateFilter("sort", event.target.value)}>
                <option value="score">Best match</option>
                <option value="price">Lowest price</option>
                <option value="rating">Highest rating</option>
              </select>
            </label>
          </div>
          <div className="filter-panel__toggles">
            <label className="switch-control">
              <input type="checkbox" checked={filters.availableOnly} onChange={(event) => updateFilter("availableOnly", event.target.checked)} />
              <span aria-hidden="true" />
              Available now
            </label>
            <label className="switch-control">
              <input type="checkbox" checked={filters.verifiedOnly} onChange={(event) => updateFilter("verifiedOnly", event.target.checked)} />
              <span aria-hidden="true" />
              Verified only
            </label>
          </div>
          <div className="filter-panel__actions">
            <button className="btn btn--ghost btn--icon-leading" type="button" onClick={resetSearch}>
              <RotateCcw size={16} aria-hidden="true" /> Reset
            </button>
            <button className="btn btn--primary btn--wide" type="submit" disabled={matching}>
              {matching ? <span className="button-spinner" aria-hidden="true" /> : <Sparkles size={17} aria-hidden="true" />}
              {matching ? "Matching network…" : "Run intelligent match"}
            </button>
          </div>
        </fieldset>
      </form>

      {compose?.matches?.length ? (
        <section className="compose-shortlist" aria-labelledby="compose-shortlist-title">
          <div className="section-heading section-heading--compact">
            <div>
              <span className="eyebrow"><Zap size={15} aria-hidden="true" /> Live signal</span>
              <h2 id="compose-shortlist-title">Grounded while you type</h2>
            </div>
            <span className="section-kicker">Top {compose.matches.length} preview</span>
          </div>
          <div className="compose-shortlist__rail">
            {compose.matches.slice(0, 3).map((resource) => (
              <article className="compose-match-card" key={resource.id}>
                <span className="compose-match-card__score">{Math.round(resourceScore(resource))}%</span>
                <div><strong>{resource.name}</strong><span>{resource.cluster} · ₹{money.format(Number(resource.pricePerDay || 0))}/day</span></div>
                <p>{resourceExplanation(resource)}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="marketplace-results" aria-labelledby="marketplace-results-title" aria-busy={matching}>
        <div className="section-heading">
          <div>
            <span className="eyebrow"><Sparkles size={15} aria-hidden="true" /> Explainable matches</span>
            <h2 id="marketplace-results-title">{visibleResults.length} network {visibleResults.length === 1 ? "match" : "matches"}</h2>
          </div>
          <span className="engine-chip"><span aria-hidden="true" /> {engineLabel}</span>
        </div>

        {matchError ? <div className="inline-alert inline-alert--warning" role="alert"><CircleAlert size={18} aria-hidden="true" /> {matchError}</div> : null}

        {visibleResults.length ? (
          <div className="resource-grid">
            {visibleResults.map((resource) => (
              <ResourceCard
                key={resource.id}
                resource={resource}
                inCart={cartIdSet.has(resource.id)}
                canBook={canBook}
                onToggleCart={(id) => onToggleCart?.(id)}
                onQuickBook={(item) => book([item.id], item.name || "Quick booking")}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-state__icon"><Search aria-hidden="true" /></span>
            <h3>No capacity surfaced yet</h3>
            <p>Broaden the cluster, raise the budget, or remove a filter and run the match again.</p>
            <button className="btn btn--secondary" type="button" onClick={resetSearch}>Clear filters</button>
          </div>
        )}
      </section>

      {canBook ? <aside className={`marketplace-cart ${cartIds.length ? "is-open" : ""}`} aria-label="Bundle cart" aria-live="polite">
        <div className="marketplace-cart__summary">
          <span className="marketplace-cart__icon"><ShoppingBasket size={20} aria-hidden="true" /><em>{cartIds.length}</em></span>
          <div>
            <strong>{cartIds.length ? "Production bundle ready" : "Build a production bundle"}</strong>
            <span>{cartIds.length ? `${cartIds.length} resources · ₹${money.format(cartTotal)}/day estimated` : "Add complementary resources from the results"}</span>
          </div>
        </div>
        {cartResources.length ? (
          <ul className="marketplace-cart__items" aria-label="Resources in bundle">
            {cartResources.slice(0, 4).map((resource) => (
              <li key={resource.id}>
                <span>{resource.name}</span>
                <button className="icon-btn" type="button" onClick={() => onToggleCart?.(resource.id)} aria-label={`Remove ${resource.name} from bundle`}>
                  <X size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
            {cartResources.length > 4 ? <li className="marketplace-cart__more">+{cartResources.length - 4} more</li> : null}
          </ul>
        ) : null}
        <button className="btn btn--primary btn--icon-leading" type="button" disabled={!cartIds.length} onClick={() => book(cartIds, "Production bundle")}>
          Request bundle <ArrowRight size={17} aria-hidden="true" />
        </button>
      </aside> : null}
    </div>
  );
}
