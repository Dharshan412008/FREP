import { useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  MessageSquareText,
  Send,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import {
  confirmCopilotAction,
  draftCopilotAction,
  sendChat,
} from "../lib/api";

function displayValue(value) {
  if (value == null || value === "") return "Not specified";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const ROLE_VIEWS = {
  buyer: new Set(["overview", "marketplace", "planner", "network", "bookings", "analytics"]),
  owner: new Set(["overview", "marketplace", "network", "listings", "analytics"]),
  admin: new Set(["overview", "marketplace", "network", "verification", "analytics"]),
};

function actionDestination(action, role) {
  let view = null;
  if (action?.type === "set_filters") view = "marketplace";
  if (action?.type === "open_planner") view = "planner";
  if (action?.type === "open_view") view = action.view === "admin" ? "verification" : action.view;
  return view && ROLE_VIEWS[role]?.has(view) ? view : null;
}

function actionLabel(action, destination) {
  if (action?.type === "set_filters") return "Open matching capacity";
  if (destination === "planner") return "Open production planner";
  if (destination === "verification") return "Open verification queue";
  if (destination === "listings") return "Open my listings";
  if (destination === "analytics") return "Open network intelligence";
  return "Open workspace view";
}

function DraftReview({ draft, busy, onConfirm, onDiscard, onNavigate }) {
  if (!draft) return null;
  const values = draft.draft && typeof draft.draft === "object" ? draft.draft : {};
  const fields = Object.entries(values).filter(
    ([key]) => !["matches", "summary", "confirmationToken"].includes(key),
  );
  const matches = Array.isArray(draft.matches) ? draft.matches.slice(0, 3) : [];
  const token = draft.confirmationToken || draft.confirmation?.body?.confirmationToken;
  const requiresConfirmation = Boolean(draft.requiresConfirmation);

  return (
    <section className="act-review" aria-label="Copilot action review">
      <div className="act-review__safety">
        <ShieldCheck size={18} />
        <div>
          <strong>Review only — nothing has changed</strong>
          <span>{draft.summary || draft.message || "Inspect the grounded proposal."}</span>
        </div>
      </div>

      {(draft.warnings?.length > 0 || draft.missingFields?.length > 0) && (
        <div className="inline-alert inline-alert--warning" role="alert">
          {[...(draft.warnings || []), ...(draft.missingFields || []).map((item) => `Missing ${item}`)].join(" · ")}
        </div>
      )}

      {fields.length > 0 && (
        <dl className="act-review__fields">
          {fields.slice(0, 10).map(([key, value]) => (
            <div key={key}>
              <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
              <dd>{displayValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {matches.length > 0 && (
        <div className="act-review__matches">
          <span className="section-kicker">Grounded in live catalogue</span>
          {matches.map((match) => (
            <article key={match.id || match.name} className="mini-match">
              <div>
                <strong>{match.name || match.id}</strong>
                <span>{match.cluster} · ₹{Number(match.pricePerDay || 0).toLocaleString("en-IN")}/day</span>
              </div>
              <span className="score-pill">{match.match?.score || match.score || "—"}%</span>
            </article>
          ))}
        </div>
      )}

      <div className="act-review__actions">
        {requiresConfirmation ? (
          <button className="button button--primary" disabled={!token || busy} onClick={() => onConfirm(token)} type="button">
            <CheckCircle2 size={17} /> {busy ? "Confirming…" : "Confirm action"}
          </button>
        ) : (
          <button className="button button--primary" onClick={() => onNavigate("marketplace", { filters: draft.filters || {} })} type="button">
            Open matches <ChevronRight size={17} />
          </button>
        )}
        <button className="button button--ghost" onClick={onDiscard} type="button">Discard</button>
      </div>
      {requiresConfirmation && (
        <p className="safety-caption">Confirmation sends only the signed, one-use server token. Displayed fields are never trusted as write input.</p>
      )}
    </section>
  );
}

export default function CopilotDrawer({ open, onClose, user, onNavigate, onRefresh, onToast }) {
  const [mode, setMode] = useState("ask");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([
    { role: "assistant", text: "Tell me what your factory needs. I can search the exchange or prepare a safe action draft." },
  ]);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const drawerRef = useRef(null);
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);
  const canDraft = user.role === "buyer" || user.role === "owner";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, draft]);

  useEffect(() => {
    if (!open) setDraft(null);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(drawerRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      const previous = previousFocusRef.current;
      if (previous?.isConnected && !previous.closest?.("[inert]")) previous.focus();
      else document.querySelector(".command-trigger")?.focus();
    };
  }, [open]);

  const submitAsk = async (event) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setMessages((current) => [...current, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    try {
      const response = await sendChat(message);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          text: response.reply || "I found a few useful signals in the network.",
          matches: response.matches || [],
          actions: response.actions || [],
        },
      ]);
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", text: error.message }]);
    } finally {
      setBusy(false);
    }
  };

  const submitDraft = async (event) => {
    event.preventDefault();
    const instruction = input.trim();
    if (!instruction || busy) return;
    setBusy(true);
    setDraft(null);
    try {
      const response = await draftCopilotAction(instruction);
      setDraft(response);
    } catch (error) {
      onToast(error.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const confirmDraft = async (token) => {
    setBusy(true);
    try {
      const response = await confirmCopilotAction(token);
      setDraft(null);
      setInput("");
      onToast(response.message || "Action confirmed", "success");
      await onRefresh(["dashboard", "resources", "bookings", "notifications", "analytics"]);
    } catch (error) {
      onToast(error.message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className={`drawer-scrim ${open ? "is-open" : ""}`} aria-label="Close Copilot" onClick={onClose} tabIndex="-1" type="button" />
      <aside ref={drawerRef} className={`copilot-drawer ${open ? "is-open" : ""}`} aria-hidden={!open} inert={!open ? true : undefined} role="dialog" aria-modal="true" aria-label="FREP Copilot">
        <header className="copilot-drawer__header">
          <div className="copilot-orb"><Sparkles size={20} /></div>
          <div>
            <span className="section-kicker">Local-first intelligence</span>
            <strong>FREP Copilot</strong>
          </div>
          <button className="icon-button" ref={closeButtonRef} onClick={onClose} aria-label="Close Copilot" type="button"><X size={20} /></button>
        </header>

        <div className="segmented-control copilot-mode" aria-label="Copilot mode">
          <button className={mode === "ask" ? "is-active" : ""} onClick={() => { setMode("ask"); setDraft(null); }} aria-pressed={mode === "ask"} type="button">
            <MessageSquareText size={16} /> Ask
          </button>
          {canDraft ? <button className={mode === "act" ? "is-active" : ""} onClick={() => setMode("act")} aria-pressed={mode === "act"} type="button">
            <WandSparkles size={16} /> Draft action
          </button> : null}
        </div>

        {mode === "ask" ? (
          <div className="copilot-thread" aria-live="polite">
            {messages.map((message, index) => (
              <article className={`copilot-message copilot-message--${message.role}`} key={`${message.role}-${index}`}>
                {message.role === "assistant" && <Bot size={16} />}
                <div>
                  <p>{message.text}</p>
                  {message.matches?.map((match) => (
                    <button key={match.id} className="copilot-match-link" onClick={() => onNavigate("marketplace")} type="button">
                      {match.name} <span>{match.cluster} · {match.semanticScore || "—"}%</span>
                    </button>
                  ))}
                  {message.actions?.map((action, actionIndex) => {
                    const destination = actionDestination(action, user.role);
                    if (!destination) return null;
                    const options = action.type === "set_filters" ? { filters: action.filters || {} } : {};
                    return (
                      <button key={`${action.type}-${destination}-${actionIndex}`} className="copilot-match-link" onClick={() => onNavigate(destination, options)} type="button">
                        {actionLabel(action, destination)} <ChevronRight size={15} aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </article>
            ))}
            {busy && <div className="thinking-line"><span /><span /><span /></div>}
            <div ref={endRef} />
          </div>
        ) : (
          <div className="copilot-act-intro">
            <div className="act-intro-card">
              <ShieldCheck size={21} />
              <div>
                <strong>Draft first. Confirm second.</strong>
                <span>{user.role === "owner" ? "Describe a listing to prepare." : "Describe a search or booking need."}</span>
              </div>
            </div>
            {draft ? (
              <DraftReview draft={draft} busy={busy} onConfirm={confirmDraft} onDiscard={() => setDraft(null)} onNavigate={onNavigate} />
            ) : (
              <div className="copilot-empty-state">
                <WandSparkles size={30} />
                <strong>Ground an action in live capacity</strong>
                <p>{user.role === "owner" ? "Try “List my 5-axis CNC in Peenya for ₹8,500 per day.”" : "Try “Book one verified CNC in Peenya below ₹9,000.”"}</p>
              </div>
            )}
          </div>
        )}

        <form className="copilot-composer" onSubmit={mode === "ask" ? submitAsk : submitDraft}>
          <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={mode === "ask" ? "Ask about capacity, clusters, or planning…" : "Describe the marketplace action…"} rows={3} maxLength={500} />
          <div>
            <span>{input.length}/500</span>
            <button className="button button--primary button--compact" disabled={!input.trim() || busy} type="submit">
              {mode === "ask" ? <Send size={16} /> : <WandSparkles size={16} />}
              {busy ? "Working…" : mode === "ask" ? "Send" : "Draft"}
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
