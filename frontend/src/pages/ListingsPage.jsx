import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Boxes,
  Check,
  CircleGauge,
  Factory,
  IndianRupee,
  MapPin,
  PackagePlus,
  PauseCircle,
  PencilLine,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";

const categories = [
  "Machinery",
  "Warehouse Space",
  "Testing Equipment",
  "Logistics Vehicle",
  "Skilled Operator",
  "Other",
];

const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const emptyForm = {
  name: "",
  category: "Machinery",
  cluster: "",
  pricePerDay: "",
  description: "",
  tags: "",
};

export default function ListingsPage({
  resources = [],
  user,
  clusters = [],
  onCreate,
  onPatch,
  onDelete,
  onToast,
}) {
  const safeResources = Array.isArray(resources) ? resources : [];
  const safeClusters = Array.isArray(clusters) ? clusters : [];
  const [form, setForm] = useState(emptyForm);
  const [priceDrafts, setPriceDrafts] = useState({});
  const [creating, setCreating] = useState(false);
  const [working, setWorking] = useState("");
  const [pendingDelete, setPendingDelete] = useState("");
  const [feedback, setFeedback] = useState("");

  const clusterNames = useMemo(() => [...new Set([
    ...safeClusters.map((cluster) => cluster.name),
    ...safeResources.map((resource) => resource.cluster),
  ].filter(Boolean))].sort(), [safeClusters, safeResources]);

  useEffect(() => {
    if (!form.cluster && clusterNames.length) {
      setForm((current) => ({ ...current, cluster: current.cluster || clusterNames[0] }));
    }
  }, [clusterNames, form.cluster]);

  const ownerResources = safeResources.filter((resource) => {
    if (user?.ownerId) return resource.ownerId === user.ownerId;
    if (user?.name) return resource.ownerName === user.name;
    return false;
  });
  const available = ownerResources.filter((resource) => resource.availability).length;
  const verified = ownerResources.filter((resource) => resource.verified).length;
  const averagePrice = ownerResources.length
    ? ownerResources.reduce((sum, resource) => sum + (Number(resource.pricePerDay) || 0), 0) / ownerResources.length
    : 0;

  const updateForm = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  const submitListing = async (event) => {
    event.preventDefault();
    const price = Number(form.pricePerDay);
    if (!form.name.trim() || !form.cluster.trim() || !form.description.trim() || !Number.isFinite(price) || price <= 0) {
      const validationMessage = "Add a name, cluster, description, and a daily rate above zero.";
      setFeedback(validationMessage);
      onToast?.(validationMessage, "error");
      return;
    }

    setCreating(true);
    setFeedback("");
    try {
      await onCreate?.({
        name: form.name.trim(),
        category: form.category,
        cluster: form.cluster.trim(),
        pricePerDay: Math.round(price),
        description: form.description.trim(),
        tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        availability: true,
      });
      setForm((current) => ({ ...emptyForm, cluster: current.cluster }));
      setFeedback("Listing submitted. It is visible to you and queued for administrator verification.");
    } catch (error) {
      const errorMessage = error?.message || "The listing could not be created.";
      setFeedback(errorMessage);
      onToast?.(errorMessage, "error");
    } finally {
      setCreating(false);
    }
  };

  const savePrice = async (resource) => {
    const price = Number(priceDrafts[resource.id] ?? resource.pricePerDay);
    if (!Number.isFinite(price) || price < 0) {
      onToast?.("Enter a valid non-negative daily rate.", "error");
      return;
    }
    setWorking(`${resource.id}:price`);
    try {
      await onPatch?.(resource.id, { pricePerDay: Math.round(price) });
      setPriceDrafts((current) => {
        const next = { ...current };
        delete next[resource.id];
        return next;
      });
    } catch (error) {
      onToast?.(error?.message || "The daily rate could not be updated.", "error");
    } finally {
      setWorking("");
    }
  };

  const toggleAvailability = async (resource) => {
    setWorking(`${resource.id}:availability`);
    try {
      await onPatch?.(resource.id, { availability: !resource.availability });
    } catch (error) {
      onToast?.(error?.message || "Availability could not be changed.", "error");
    } finally {
      setWorking("");
    }
  };

  const removeListing = async (resource) => {
    setWorking(`${resource.id}:delete`);
    try {
      await onDelete?.(resource.id);
      setPendingDelete("");
    } catch (error) {
      onToast?.(error?.message || "The listing could not be removed.", "error");
    } finally {
      setWorking("");
    }
  };

  return (
    <div className="page-stack listings-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow"><Factory aria-hidden="true" /> Owner studio</span>
          <h1>Your capacity portfolio</h1>
          <p>Publish idle infrastructure, control live availability, and build a trusted operating record.</p>
        </div>
        <div className="owner-identity-card">
          <span className="owner-identity-card__mark"><Factory aria-hidden="true" /></span>
          <div><small>Owner profile</small><strong>{user?.name || "Resource owner"}</strong><span>{user?.ownerId || "Profile connection pending"}</span></div>
          {user?.ownerId ? <BadgeCheck aria-label="Owner profile connected" /> : null}
        </div>
      </header>

      <section className="listing-summary" aria-label="Portfolio summary">
        <article><Boxes aria-hidden="true" /><div><span>Total listings</span><strong>{ownerResources.length}</strong></div></article>
        <article><Zap aria-hidden="true" /><div><span>Available now</span><strong>{available}</strong></div></article>
        <article><BadgeCheck aria-hidden="true" /><div><span>Verified</span><strong>{verified}</strong></div></article>
        <article><IndianRupee aria-hidden="true" /><div><span>Average day rate</span><strong>{currencyFormatter.format(averagePrice)}</strong></div></article>
      </section>

      <section className="listing-create-layout">
        <article className="panel listing-form-panel">
          <header className="panel__header">
            <div>
              <span className="eyebrow"><PackagePlus aria-hidden="true" /> Add capacity</span>
              <h2>Create a resource listing</h2>
              <p>Give buyers enough detail to judge production fit before they book.</p>
            </div>
            <span className="draft-chip"><Sparkles aria-hidden="true" /> New listing</span>
          </header>

          <form className="listing-form" onSubmit={submitListing}>
            <div className="form-field form-field--wide">
              <label htmlFor="listing-name">Resource name</label>
              <div className="input-shell"><Factory aria-hidden="true" /><input id="listing-name" value={form.name} onChange={(event) => updateForm("name", event.target.value)} placeholder="e.g. 5-axis machining centre" maxLength="120" required /></div>
            </div>

            <div className="form-field">
              <label htmlFor="listing-category">Category</label>
              <select id="listing-category" value={form.category} onChange={(event) => updateForm("category", event.target.value)}>
                {categories.map((category) => <option key={category}>{category}</option>)}
              </select>
            </div>

            <div className="form-field">
              <label htmlFor="listing-cluster">Industrial cluster</label>
              <div className="input-shell"><MapPin aria-hidden="true" /><input id="listing-cluster" list="listing-clusters" value={form.cluster} onChange={(event) => updateForm("cluster", event.target.value)} placeholder="Choose or enter a cluster" required /></div>
              <datalist id="listing-clusters">{clusterNames.map((cluster) => <option value={cluster} key={cluster} />)}</datalist>
            </div>

            <div className="form-field">
              <label htmlFor="listing-price">Daily access rate</label>
              <div className="input-shell"><IndianRupee aria-hidden="true" /><input id="listing-price" type="number" min="1" step="1" value={form.pricePerDay} onChange={(event) => updateForm("pricePerDay", event.target.value)} placeholder="6500" required /></div>
            </div>

            <div className="form-field">
              <label htmlFor="listing-tags">Capability tags</label>
              <div className="input-shell"><Sparkles aria-hidden="true" /><input id="listing-tags" value={form.tags} onChange={(event) => updateForm("tags", event.target.value)} placeholder="precision, automotive, milling" /></div>
              <small>Separate search terms with commas.</small>
            </div>

            <div className="form-field form-field--wide">
              <label htmlFor="listing-description">Production description</label>
              <textarea id="listing-description" value={form.description} onChange={(event) => updateForm("description", event.target.value)} placeholder="Describe tolerances, typical jobs, operating constraints, and what is included…" rows="4" maxLength="1000" required />
              <small>{form.description.length}/1000 characters</small>
            </div>

            {feedback ? <div className="inline-notice form-field--wide" role="status"><Check aria-hidden="true" /> {feedback}</div> : null}

            <div className="listing-form__footer form-field--wide">
              <div><ShieldCheck aria-hidden="true" /><span><strong>Verification protected</strong><small>New listings start unverified and enter the admin queue.</small></span></div>
              <button className="button button--primary" type="submit" disabled={creating}>
                <Plus aria-hidden="true" /> {creating ? "Submitting…" : "Submit listing"}
              </button>
            </div>
          </form>
        </article>

        <aside className="listing-playbook">
          <span className="eyebrow"><CircleGauge aria-hidden="true" /> Listing strength</span>
          <h2>Make your capacity easy to match.</h2>
          <ol>
            <li><span>01</span><div><strong>Name the exact capability</strong><p>Machine type and process terms improve grounded matching.</p></div></li>
            <li><span>02</span><div><strong>Set an actionable day rate</strong><p>Transparent pricing helps buyers build viable bundles.</p></div></li>
            <li><span>03</span><div><strong>Keep availability current</strong><p>Pause a resource the moment it is committed elsewhere.</p></div></li>
          </ol>
          <div className="listing-playbook__signal"><Sparkles aria-hidden="true" /><span><strong>Good descriptions convert</strong><small>Include materials, tolerances, capacity, and operator support.</small></span></div>
        </aside>
      </section>

      <section className="portfolio-section" aria-labelledby="portfolio-title">
        <header className="section-heading">
          <div><span className="eyebrow"><Boxes aria-hidden="true" /> Live portfolio</span><h2 id="portfolio-title">Manage your listings</h2></div>
          <p>{available} of {ownerResources.length} resources accepting work</p>
        </header>

        {ownerResources.length ? (
          <div className="listing-card-grid">
            {ownerResources.map((resource) => (
              <article className={`listing-card ${resource.availability ? "listing-card--available" : "listing-card--paused"}`} key={resource.id}>
                <header className="listing-card__header">
                  <span className="listing-card__mark">{String(resource.category || "R").slice(0, 2).toUpperCase()}</span>
                  <div><span>{resource.category}</span><h3>{resource.name}</h3><p><MapPin aria-hidden="true" /> {resource.cluster}</p></div>
                  <span className={`status-badge ${resource.verified ? "status-badge--success" : "status-badge--pending"}`}>{resource.verified ? "Verified" : "In review"}</span>
                </header>

                <p className="listing-card__description">{resource.description || "No description supplied."}</p>

                <div className="listing-card__signals">
                  <span><CircleGauge aria-hidden="true" /><strong>{resource.healthScore ?? "—"}</strong> health</span>
                  <span><BadgeCheck aria-hidden="true" /><strong>{resource.trustScore ?? "—"}</strong> trust</span>
                  <span><Sparkles aria-hidden="true" /><strong>{resource.rating ?? "—"}</strong> rating</span>
                </div>

                <div className="listing-card__controls">
                  <div className="rate-editor">
                    <label htmlFor={`price-${resource.id}`}>Daily rate</label>
                    <div className="rate-editor__row">
                      <div className="input-shell"><IndianRupee aria-hidden="true" /><input id={`price-${resource.id}`} type="number" min="0" step="1" value={priceDrafts[resource.id] ?? resource.pricePerDay ?? ""} onChange={(event) => setPriceDrafts((current) => ({ ...current, [resource.id]: event.target.value }))} /></div>
                      <button className="icon-button" type="button" aria-label={`Save daily rate for ${resource.name}`} disabled={working === `${resource.id}:price`} onClick={() => savePrice(resource)}><PencilLine aria-hidden="true" /></button>
                    </div>
                  </div>

                  <div className="availability-control">
                    <div><span>Marketplace availability</span><strong>{resource.availability ? "Accepting work" : "Paused"}</strong></div>
                    <button className={`switch ${resource.availability ? "is-on" : ""}`} type="button" role="switch" aria-checked={Boolean(resource.availability)} aria-label={`${resource.availability ? "Pause" : "Open"} ${resource.name}`} disabled={working === `${resource.id}:availability`} onClick={() => toggleAvailability(resource)}><span aria-hidden="true" /></button>
                  </div>
                </div>

                <footer className="listing-card__footer">
                  <span className={`availability-label ${resource.availability ? "availability-label--open" : "availability-label--paused"}`}>{resource.availability ? <Zap aria-hidden="true" /> : <PauseCircle aria-hidden="true" />}{resource.availability ? "Discoverable by buyers" : "Hidden from active matches"}</span>
                  <button className="text-button text-button--danger" type="button" onClick={() => setPendingDelete(resource.id)}><Trash2 aria-hidden="true" /> Remove</button>
                </footer>

                {pendingDelete === resource.id ? (
                  <div className="delete-confirmation" role="alertdialog" aria-labelledby={`delete-title-${resource.id}`}>
                    <AlertTriangle aria-hidden="true" />
                    <div><strong id={`delete-title-${resource.id}`}>Remove this listing?</strong><p>It will disappear from your portfolio and cannot be restored here.</p></div>
                    <div>
                      <button className="button button--danger button--small" type="button" disabled={working === `${resource.id}:delete`} onClick={() => removeListing(resource)}>{working === `${resource.id}:delete` ? "Removing…" : "Yes, remove"}</button>
                      <button className="icon-button" type="button" aria-label="Cancel removal" onClick={() => setPendingDelete("")}><X aria-hidden="true" /></button>
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state empty-state--feature">
            <PackagePlus aria-hidden="true" />
            <h3>Publish your first shared resource</h3>
            <p>Your owner portfolio is empty. Complete the listing form to enter the verification queue.</p>
            <span>Start above <ArrowRight aria-hidden="true" /></span>
          </div>
        )}
      </section>
    </div>
  );
}
