import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Boxes,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock3,
  Factory,
  Gauge,
  GitCompareArrows,
  IndianRupee,
  Layers3,
  MapPin,
  Mic,
  MicOff,
  Package,
  Route,
  Scale,
  ShieldCheck,
  Sparkles,
  Target,
  Truck,
  WandSparkles,
  Workflow,
  Zap,
} from "lucide-react";
import { createProductionPlan, getTypeahead } from "../lib/api.js";

const EMPTY_REQUIREMENT = {
  productName: "",
  quantity: "",
  material: "",
  processes: "",
  deadline: "",
  budget: "",
  cluster: "",
  quality: "Standard",
  transport: "Standard",
};

const DEMO_REQUIREMENT = {
  productName: "Aluminium Bracket",
  quantity: "2000",
  material: "Aluminium",
  processes: "CNC machining, Surface finishing, Quality inspection, Logistics",
  deadline: "5",
  budget: "100000",
  cluster: "Coimbatore",
  quality: "High",
  transport: "Standard",
};

const DEMO_NATURAL_LANGUAGE =
  "Produce 2,000 aluminium brackets in Coimbatore within 5 days using CNC machining, finishing, inspection and logistics, budget ₹100,000";

const VOICE_LANGUAGES = [
  { value: "en-IN", label: "English" },
  { value: "hi-IN", label: "हिन्दी" },
  { value: "ta-IN", label: "தமிழ்" },
  { value: "te-IN", label: "తెలుగు" },
];

const money = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

function clusterName(cluster) {
  return typeof cluster === "string" ? cluster : cluster?.name || cluster?.city || "";
}

function fieldValue(field) {
  return field && typeof field === "object" && "value" in field ? field.value : field;
}

function humanize(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function numericScore(item) {
  return Math.max(
    0,
    Math.min(
      100,
      Number(item?.scoreBreakdown?.score ?? item?.match?.score ?? item?.score ?? 0) || 0,
    ),
  );
}

function chainWhy(item) {
  return (
    item?.why ||
    item?.scoreBreakdown?.why ||
    item?.match?.why ||
    item?.explanation?.why ||
    "Selected from capability, availability, cost, trust and logistics signals."
  );
}

function chainFactors(item) {
  const breakdown = item?.scoreBreakdown || item?.match || {};
  const contributions = item?.contributions || breakdown.contributions;
  const weights = item?.weights || breakdown.weights || {};
  if (contributions && typeof contributions === "object") {
    return Object.entries(contributions).map(([name, value]) => ({
      name,
      value,
      weight: weights[name],
    }));
  }
  const factors = breakdown.breakdown || {};
  return Object.entries(factors)
    .filter(([name]) => name !== "blendedScore")
    .map(([name, value]) => ({ name, value, weight: undefined }));
}

function formatFactor(value, weight) {
  const number = Number(value);
  const score = Number.isFinite(number)
    ? `${Math.round((number <= 1 ? number * 100 : number) * 10) / 10}${number <= 1 ? "%" : " pts"}`
    : String(value ?? "—");
  const numericWeight = Number(weight);
  return Number.isFinite(numericWeight)
    ? `${score} · ${Math.round(numericWeight <= 1 ? numericWeight * 100 : numericWeight)}% weight`
    : score;
}

function riskClass(risk) {
  const normalized = String(risk || "").toLowerCase();
  if (normalized === "low") return "risk-chip--low";
  if (normalized === "medium") return "risk-chip--medium";
  return "risk-chip--high";
}

function RequirementSummary({ requirements, plan }) {
  const title = requirements.product_name || requirements.productName || "Production requirement";
  const quantity = requirements.quantity;
  const material = requirements.material;
  return (
    <header className="plan-result__summary">
      <div className="plan-result__summary-icon"><Target aria-hidden="true" /></div>
      <div>
        <span className="eyebrow">Requirement analysed</span>
        <h2>{title}</h2>
        <p>
          {[quantity ? `${money.format(Number(quantity))} units` : "", material, requirements.cluster]
            .filter(Boolean)
            .join(" · ") || "Structured from your production brief"}
        </p>
      </div>
      <span className={`feasibility-chip ${plan.feasible ? "is-feasible" : "needs-review"}`}>
        {plan.feasible ? <CircleCheck size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
        {plan.feasible ? "Feasible chain" : "Needs review"}
      </span>
    </header>
  );
}

function CapabilityChain({ chain = [] }) {
  if (!chain.length) {
    return (
      <div className="empty-state empty-state--compact">
        <Route aria-hidden="true" />
        <h3>No complete chain found</h3>
        <p>Try a wider cluster, deadline or budget so more network capacity can qualify.</p>
      </div>
    );
  }

  return (
    <ol className="capability-chain">
      {chain.map((item, index) => {
        const resource = item.resource || {};
        const score = numericScore(item);
        const factors = chainFactors(item);
        return (
          <li className="chain-step" key={`${item.capability || "step"}-${resource.id || index}`}>
            <div className="chain-step__rail" aria-hidden="true">
              <span>{String(index + 1).padStart(2, "0")}</span>
            </div>
            <article className="chain-step__card">
              <div className="chain-step__topline">
                <span className="chain-step__capability">{item.capability || "Production step"}</span>
                <span className="chain-step__score">{Math.round(score)}% fit</span>
              </div>
              <div className="chain-step__resource">
                <div>
                  <h4>{resource.name || "Matched resource"}</h4>
                  <p><MapPin size={14} aria-hidden="true" /> {resource.cluster || "FREP network"} {resource.ownerName ? `· ${resource.ownerName}` : ""}</p>
                </div>
                {resource.verified ? <span className="verified-mark"><ShieldCheck size={16} aria-hidden="true" /> Verified</span> : null}
              </div>
              <div className="chain-step__metrics">
                <span><IndianRupee size={14} aria-hidden="true" /> {money.format(Number(resource.pricePerDay || 0))}/day</span>
                <span><Gauge size={14} aria-hidden="true" /> Rating {resource.rating ?? "—"}</span>
                {item.estimatedTransport != null ? <span><Truck size={14} aria-hidden="true" /> ₹{money.format(Number(item.estimatedTransport))} transport</span> : null}
              </div>
              <div className="chain-step__score-track" aria-hidden="true"><span style={{ width: `${score}%` }} /></div>
              <p className="chain-step__why"><Sparkles size={15} aria-hidden="true" /> {chainWhy(item)}</p>
              {factors.length ? (
                <details className="factor-details">
                  <summary>Decision factors <ChevronDown size={15} aria-hidden="true" /></summary>
                  <dl>
                    {factors.slice(0, 8).map((factor) => (
                      <div key={factor.name}>
                        <dt>{humanize(factor.name)}</dt>
                        <dd>{formatFactor(factor.value, factor.weight)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
            </article>
          </li>
        );
      })}
    </ol>
  );
}

function PlanOptions({ options = [] }) {
  if (!options.length) return <p className="section-empty">No bundle alternatives were generated.</p>;
  return (
    <div className="plan-options">
      {options.map((option, index) => {
        const score = Math.max(0, Math.min(100, Number(option.score || 0)));
        return (
          <article className={`plan-option ${index === 0 ? "plan-option--recommended" : ""}`} key={`${option.label}-${index}`}>
            <div className="plan-option__heading">
              <div>
                {index === 0 ? <span className="recommendation-label"><Zap size={13} aria-hidden="true" /> Recommended</span> : null}
                <h4>{option.label || `Option ${index + 1}`}</h4>
              </div>
              <span className={`risk-chip ${riskClass(option.risk)}`}>{option.risk || "Review"} risk</span>
            </div>
            <div className="plan-option__price"><IndianRupee size={20} aria-hidden="true" /><strong>{money.format(Number(option.estimatedTotal || 0))}</strong><span>estimated</span></div>
            <dl className="plan-option__metrics">
              <div><dt><Clock3 size={15} aria-hidden="true" /> Duration</dt><dd>{option.estimatedDuration ?? "—"} days</dd></div>
              <div><dt><Truck size={15} aria-hidden="true" /> Transport</dt><dd>₹{money.format(Number(option.estimatedTransport || 0))}</dd></div>
              <div><dt><Target size={15} aria-hidden="true" /> Chain score</dt><dd>{Math.round(score)}%</dd></div>
            </dl>
            <div className="plan-option__score" aria-hidden="true"><span style={{ width: `${score}%` }} /></div>
          </article>
        );
      })}
    </div>
  );
}

function DecisionAnalysis({ decisions = [] }) {
  const maxCost = Math.max(...decisions.map((decision) => Number(decision.estimatedCost || 0)), 1);
  if (!decisions.length) return <p className="section-empty">Decision estimates are unavailable for this chain.</p>;
  return (
    <div className="decision-table" role="table" aria-label="Estimated production route comparison">
      <div className="decision-table__head" role="row">
        <span role="columnheader">Route</span>
        <span role="columnheader">Estimated cost</span>
        <span role="columnheader">Estimated time</span>
        <span role="columnheader">Assumption</span>
      </div>
      {decisions.map((decision) => {
        const isFrep = String(decision.option || "").toLowerCase().includes("frep");
        const cost = Number(decision.estimatedCost || 0);
        return (
          <div className={`decision-table__row ${isFrep ? "is-highlighted" : ""}`} role="row" key={decision.option}>
            <div role="cell"><span className="decision-route-icon">{isFrep ? <Sparkles size={17} aria-hidden="true" /> : <Factory size={17} aria-hidden="true" />}</span><strong>{decision.option}</strong>{isFrep ? <em>Network route</em> : null}</div>
            <div role="cell" className="decision-cost">
              <strong>₹{money.format(cost)}</strong>
              <span aria-hidden="true"><i style={{ width: `${Math.max(4, (cost / maxCost) * 100)}%` }} /></span>
            </div>
            <span role="cell">{decision.estimatedDays ?? "—"} days</span>
            <small role="cell">{decision.assumption || "Planning estimate only."}</small>
          </div>
        );
      })}
    </div>
  );
}

export default function PlannerPage({ clusters = [], onToast }) {
  const [requirement, setRequirement] = useState(EMPTY_REQUIREMENT);
  const [naturalLanguage, setNaturalLanguage] = useState("");
  const [compose, setCompose] = useState(null);
  const [composeLoading, setComposeLoading] = useState(false);
  const [composeError, setComposeError] = useState("");
  const [planResponse, setPlanResponse] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [voiceLanguage, setVoiceLanguage] = useState("en-IN");
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const voiceBaseRef = useRef("");
  const naturalLanguageRef = useRef(naturalLanguage);

  const clusterOptions = useMemo(
    () => [...new Set(clusters.map(clusterName).filter(Boolean))].sort(),
    [clusters],
  );
  const speechSupported =
    typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

  useEffect(() => {
    naturalLanguageRef.current = naturalLanguage;
  }, [naturalLanguage]);

  useEffect(() => {
    if (naturalLanguage.trim().length < 3) {
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
        const response = await getTypeahead(
          naturalLanguage,
          { source: "planner", form: requirement },
          { signal: controller.signal },
        );
        setCompose(response);
      } catch (error) {
        if (error?.name !== "AbortError") {
          setCompose(null);
          setComposeError("Compose preview is unavailable. Your typed plan can still be submitted.");
        }
      } finally {
        if (!controller.signal.aborted) setComposeLoading(false);
      }
    }, 380);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [naturalLanguage, requirement]);

  useEffect(
    () => () => {
      recognitionRef.current?.abort();
    },
    [],
  );

  function updateRequirement(name, value) {
    setRequirement((current) => ({ ...current, [name]: value }));
    setSubmitError("");
  }

  function acceptCompletion() {
    if (compose?.completion) setNaturalLanguage((current) => `${current}${compose.completion}`);
  }

  function applyComposeFields() {
    const fields = compose?.fields || {};
    setRequirement((current) => ({
      ...current,
      material: fieldValue(fields.material) || current.material,
      processes: fieldValue(fields.processes) || current.processes,
      quantity: fieldValue(fields.quantity) ?? current.quantity,
      deadline: fieldValue(fields.deadline) ?? current.deadline,
      budget: fieldValue(fields.budget) ?? current.budget,
      cluster: fieldValue(fields.cluster) || current.cluster,
    }));
    onToast?.("Observed production fields applied. Review them before generating.", "success");
  }

  function loadDemo() {
    setRequirement(DEMO_REQUIREMENT);
    setNaturalLanguage(DEMO_NATURAL_LANGUAGE);
    setPlanResponse(null);
    setSubmitError("");
    onToast?.("Demo brief loaded. Select Generate production plan when ready.", "info");
  }

  function handleNaturalLanguageKeyDown(event) {
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
    voiceBaseRef.current = naturalLanguageRef.current.trim();
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
      setNaturalLanguage([voiceBaseRef.current, transcript].filter(Boolean).join(" "));
    };
    recognitionRef.current = recognition;
    recognition.start();
  }

  function stopVoice() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }

  async function submitPlan(event) {
    event.preventDefault();
    const hasStructuredBrief = Boolean(
      requirement.productName.trim() || requirement.material.trim() || requirement.processes.trim(),
    );
    if (!naturalLanguage.trim() && !hasStructuredBrief) {
      const message = "Describe the production requirement or complete the structured brief first.";
      setSubmitError(message);
      onToast?.(message, "warning");
      return;
    }

    setSubmitting(true);
    setSubmitError("");
    try {
      const payload = {
        productName: requirement.productName.trim() || undefined,
        quantity: requirement.quantity === "" ? undefined : Number(requirement.quantity),
        material: requirement.material.trim() || undefined,
        processes: requirement.processes.trim() || undefined,
        deadline: requirement.deadline === "" ? undefined : Number(requirement.deadline),
        budget: requirement.budget === "" ? undefined : Number(requirement.budget),
        cluster: requirement.cluster || undefined,
        quality: requirement.quality,
        transport: requirement.transport,
        naturalLanguage: naturalLanguage.trim() || undefined,
      };
      const response = await createProductionPlan(payload);
      setPlanResponse(response);
      onToast?.("Explainable production chain generated.", "success");
    } catch (error) {
      const message = error?.message || "The production plan could not be generated.";
      setSubmitError(message);
      onToast?.(message, "error");
    } finally {
      setSubmitting(false);
    }
  }

  const plan = planResponse?.bundle || planResponse?.plan || null;
  const analysedRequirements = planResponse?.requirements || requirement;

  return (
    <div className="planner-page">
      <section className="page-hero planner-hero" aria-labelledby="planner-title">
        <div className="page-hero__copy">
          <span className="eyebrow"><Workflow size={16} aria-hidden="true" /> Production studio</span>
          <h1 id="planner-title">Turn one manufacturing brief into a connected resource chain.</h1>
          <p>Map capabilities, compare bundle trade-offs and see every assumption before committing production spend.</p>
          <div className="planner-hero__steps" aria-label="Planning stages">
            <span><em>01</em> Brief</span><ArrowRight size={15} aria-hidden="true" />
            <span><em>02</em> Chain</span><ArrowRight size={15} aria-hidden="true" />
            <span><em>03</em> Decide</span>
          </div>
        </div>
        <div className="planner-hero__blueprint" aria-hidden="true">
          <span className="blueprint-node blueprint-node--input"><Package /></span>
          <span className="blueprint-line blueprint-line--one" />
          <span className="blueprint-node blueprint-node--process"><Factory /></span>
          <span className="blueprint-line blueprint-line--two" />
          <span className="blueprint-node blueprint-node--output"><Boxes /></span>
        </div>
      </section>

      <form className="planner-workbench" onSubmit={submitPlan}>
        <section className="planner-brief" aria-labelledby="natural-brief-title">
          <div className="section-heading section-heading--compact">
            <div>
              <span className="eyebrow"><WandSparkles size={15} aria-hidden="true" /> Natural-language brief</span>
              <h2 id="natural-brief-title">Describe the outcome</h2>
            </div>
            <button className="btn btn--ghost btn--small" type="button" onClick={loadDemo}>Load demo brief</button>
          </div>
          <label className="planner-nl-control" htmlFor="planner-natural-language">
            <span className="sr-only">Production requirement in natural language</span>
            <textarea
              id="planner-natural-language"
              rows="5"
              value={naturalLanguage}
              onChange={(event) => {
                setNaturalLanguage(event.target.value);
                setSubmitError("");
              }}
              onKeyDown={handleNaturalLanguageKeyDown}
              placeholder="Example: Make 2,000 aluminium brackets in Coimbatore within 5 days using CNC, finishing and inspection, under ₹100,000"
              aria-describedby="planner-compose-status"
            />
            <span className="planner-nl-control__corner"><Sparkles size={18} aria-hidden="true" /></span>
          </label>

          <div className="voice-row" aria-label="Planner voice controls">
            <div className="voice-language">
              <label htmlFor="planner-voice-language">Voice language</label>
              <select id="planner-voice-language" value={voiceLanguage} onChange={(event) => setVoiceLanguage(event.target.value)} disabled={listening}>
                {VOICE_LANGUAGES.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
              </select>
            </div>
            <button className={`btn btn--voice ${listening ? "is-listening" : ""}`} type="button" onClick={listening ? stopVoice : startVoice} disabled={!speechSupported}>
              {listening ? <MicOff size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
              {listening ? "Stop listening" : "Speak production brief"}
            </button>
            <span className="voice-status" role="status">{listening ? "Listening…" : speechSupported ? "English, हिन्दी, தமிழ் or తెలుగు" : "Voice is unavailable in this browser"}</span>
          </div>

          <div className={`compose-preview compose-preview--planner ${composeLoading ? "is-loading" : ""}`} id="planner-compose-status" aria-live="polite">
            <div className="compose-preview__heading"><span><Zap size={16} aria-hidden="true" /> Requirement parser</span>{compose?.durationMs != null ? <small>{Math.round(compose.durationMs)} ms</small> : null}</div>
            {composeLoading ? (
              <p className="skeleton-line">Extracting production signals…</p>
            ) : composeError ? (
              <p className="compose-preview__muted">{composeError}</p>
            ) : compose ? (
              <>
                {compose.completion ? <button className="completion-chip" type="button" onClick={acceptCompletion}><span>Press Tab or add</span> “{compose.completion}” <ArrowRight size={14} aria-hidden="true" /></button> : null}
                {Object.keys(compose.fields || {}).length ? (
                  <div className="compose-preview__fields">
                    <div className="compose-preview__chips">
                      {Object.entries(compose.fields).map(([name, field]) => (
                        <span className="data-chip" key={name}><small>{humanize(name)}</small>{String(fieldValue(field))}{field?.confidence != null ? <em>{Math.round(field.confidence * 100)}%</em> : null}</span>
                      ))}
                    </div>
                    <button className="btn btn--text" type="button" onClick={applyComposeFields}>Apply to structured brief <ArrowRight size={15} aria-hidden="true" /></button>
                  </div>
                ) : <p className="compose-preview__muted">Mention quantity, material, processes, cluster, deadline or budget to structure the brief.</p>}
              </>
            ) : <p className="compose-preview__muted">The parser previews fields while you type. It never generates a plan until you submit.</p>}
          </div>
        </section>

        <section className="structured-brief" aria-labelledby="structured-brief-title">
          <div className="section-heading section-heading--compact">
            <div>
              <span className="eyebrow"><Layers3 size={15} aria-hidden="true" /> Structured controls</span>
              <h2 id="structured-brief-title">Tune the constraints</h2>
            </div>
            <span className="section-kicker">Optional with a natural-language brief</span>
          </div>
          <div className="structured-brief__grid">
            <label className="field-control field-control--wide"><span>Product or component</span><input type="text" value={requirement.productName} onChange={(event) => updateRequirement("productName", event.target.value)} placeholder="Aluminium bracket" maxLength="100" /></label>
            <label className="field-control"><span>Quantity</span><input type="number" min="1" step="1" inputMode="numeric" value={requirement.quantity} onChange={(event) => updateRequirement("quantity", event.target.value)} placeholder="2,000" /></label>
            <label className="field-control"><span>Material</span><input type="text" value={requirement.material} onChange={(event) => updateRequirement("material", event.target.value)} placeholder="Aluminium" /></label>
            <label className="field-control field-control--wide"><span>Required processes</span><input type="text" value={requirement.processes} onChange={(event) => updateRequirement("processes", event.target.value)} placeholder="CNC machining, finishing, inspection" /></label>
            <label className="field-control"><span>Deadline</span><div className="input-with-suffix"><input type="number" min="1" max="365" step="1" inputMode="numeric" value={requirement.deadline} onChange={(event) => updateRequirement("deadline", event.target.value)} placeholder="7" /><span>days</span></div></label>
            <label className="field-control"><span>Total budget</span><div className="input-with-icon"><IndianRupee size={16} aria-hidden="true" /><input type="number" min="0" step="100" inputMode="numeric" value={requirement.budget} onChange={(event) => updateRequirement("budget", event.target.value)} placeholder="100,000" /></div></label>
            <label className="field-control"><span>Preferred cluster</span><select value={requirement.cluster} onChange={(event) => updateRequirement("cluster", event.target.value)}><option value="">Best network fit</option>{clusterOptions.map((cluster) => <option key={cluster} value={cluster}>{cluster}</option>)}</select></label>
            <label className="field-control"><span>Quality level</span><select value={requirement.quality} onChange={(event) => updateRequirement("quality", event.target.value)}><option value="Standard">Standard</option><option value="High">High precision</option><option value="Critical">Mission critical</option></select></label>
            <label className="field-control"><span>Transport priority</span><select value={requirement.transport} onChange={(event) => updateRequirement("transport", event.target.value)}><option value="Standard">Balanced</option><option value="Economy">Lowest cost</option><option value="Express">Fastest route</option></select></label>
          </div>
          <div className="planner-submit">
            <div className="planner-submit__note"><CircleCheck size={17} aria-hidden="true" /><span><strong>You stay in control.</strong> Generating happens only when you select the button.</span></div>
            <button className="btn btn--primary btn--hero" type="submit" disabled={submitting}>
              {submitting ? <span className="button-spinner" aria-hidden="true" /> : <GitCompareArrows size={19} aria-hidden="true" />}
              {submitting ? "Optimising the chain…" : "Generate production plan"}
              {!submitting ? <ArrowRight size={18} aria-hidden="true" /> : null}
            </button>
          </div>
          {submitError ? <div className="inline-alert inline-alert--error" role="alert"><CircleAlert size={18} aria-hidden="true" /> {submitError}</div> : null}
        </section>
      </form>

      <section className={`plan-result ${submitting ? "is-loading" : ""}`} aria-labelledby="plan-result-title" aria-live="polite" aria-busy={submitting}>
        {!plan ? (
          <div className="planner-empty">
            <div className="planner-empty__visual" aria-hidden="true"><span><Package /></span><i /><span><Factory /></span><i /><span><Boxes /></span></div>
            <span className="eyebrow"><Route size={15} aria-hidden="true" /> Awaiting your brief</span>
            <h2 id="plan-result-title">Your capability chain will appear here.</h2>
            <p>Generate a plan to see the recommended sequence, bundle alternatives and transparent buy-versus-share analysis.</p>
          </div>
        ) : (
          <>
            <RequirementSummary requirements={analysedRequirements} plan={plan} />
            {planResponse?.requestId ? <p className="plan-request-id">Planning request {planResponse.requestId}</p> : null}

            <section className="plan-capabilities" aria-labelledby="capabilities-title">
              <div className="section-heading section-heading--compact"><div><span className="eyebrow"><Workflow size={15} aria-hidden="true" /> Capability map</span><h3 id="capabilities-title">Required production spine</h3></div><span className="section-kicker">{(plan.capabilities || []).length} stages detected</span></div>
              <div className="capability-pills" aria-label="Required capabilities">{(plan.capabilities || []).map((capability, index) => <span key={`${capability}-${index}`}><em>{String(index + 1).padStart(2, "0")}</em>{capability}{index < plan.capabilities.length - 1 ? <ArrowRight size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}</span>)}</div>
            </section>

            <section className="plan-section" aria-labelledby="recommended-chain-title">
              <div className="section-heading"><div><span className="eyebrow"><Route size={15} aria-hidden="true" /> Recommended chain</span><h3 id="recommended-chain-title">Connected resources, step by step</h3></div><span className="section-kicker">Ranked and explainable</span></div>
              <CapabilityChain chain={plan.chain || []} />
            </section>

            <section className="plan-section" aria-labelledby="bundle-options-title">
              <div className="section-heading"><div><span className="eyebrow"><Scale size={15} aria-hidden="true" /> Bundle alternatives</span><h3 id="bundle-options-title">Choose the trade-off that fits</h3></div><span className="section-kicker">All figures are estimates</span></div>
              <PlanOptions options={plan.options || []} />
            </section>

            <section className="plan-section decision-section" aria-labelledby="decision-analysis-title">
              <div className="section-heading"><div><span className="eyebrow"><GitCompareArrows size={15} aria-hidden="true" /> Decision analysis</span><h3 id="decision-analysis-title">Buy, outsource or share?</h3></div><span className="section-kicker">Transparent demo assumptions</span></div>
              <DecisionAnalysis decisions={plan.decisionAnalysis || []} />
              <p className="estimate-caveat"><CircleAlert size={15} aria-hidden="true" /> Planning guidance only. Costs and lead times are deterministic estimates, not supplier quotes.</p>
            </section>
          </>
        )}
      </section>
    </div>
  );
}
