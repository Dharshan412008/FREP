import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Factory,
  FileCheck2,
  Gauge,
  IndianRupee,
  MapPin,
  ScanLine,
  Search,
  ShieldAlert,
  ShieldCheck,
  UserRoundCheck,
  X,
} from "lucide-react";

const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

function reviewChecks(resource) {
  return [
    { label: "Owner identity attached", passed: Boolean(resource.ownerId && resource.ownerName), icon: UserRoundCheck },
    { label: "Production description supplied", passed: String(resource.description || "").trim().length >= 24, icon: FileCheck2 },
    { label: "Commercial rate is valid", passed: Number(resource.pricePerDay) > 0, icon: IndianRupee },
    { label: "Operational health is acceptable", passed: resource.healthScore == null || Number(resource.healthScore) >= 70, icon: Gauge },
  ];
}

export default function VerificationPage({ resources = [], onVerify }) {
  const safeResources = Array.isArray(resources) ? resources : [];
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState("");
  const [feedback, setFeedback] = useState("");

  const pending = safeResources.filter((resource) => !resource.verified);
  const verified = safeResources.filter((resource) => resource.verified);
  const queue = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return pending;
    return pending.filter((resource) => `${resource.name} ${resource.category} ${resource.cluster} ${resource.ownerName}`.toLowerCase().includes(needle));
  }, [pending, query]);

  const readyCount = pending.filter((resource) => reviewChecks(resource).every((check) => check.passed)).length;
  const verifiedCoverage = safeResources.length ? Math.round((verified.length / safeResources.length) * 100) : 0;

  const decide = async (resource, approved) => {
    const key = `${resource.id}:${approved ? "approve" : "return"}`;
    setWorking(key);
    setFeedback("");
    try {
      await onVerify?.(resource.id, approved);
      setFeedback(approved
        ? `${resource.name} is now verified and eligible for trusted marketplace matches.`
        : `${resource.name} remains unverified and has been returned for owner changes.`);
    } catch (error) {
      setFeedback(error?.message || "The verification decision could not be recorded.");
    } finally {
      setWorking("");
    }
  };

  return (
    <div className="page-stack verification-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow"><ShieldCheck aria-hidden="true" /> Admin trust desk</span>
          <h1>Verification queue</h1>
          <p>Review ownership, operating detail, and commercial readiness before a listing earns the network badge.</p>
        </div>
        <div className="verification-coverage">
          <span className="verification-coverage__icon"><BadgeCheck aria-hidden="true" /></span>
          <div><small>Verified coverage</small><strong>{verifiedCoverage}%</strong><span>{verified.length} of {safeResources.length} resources</span></div>
        </div>
      </header>

      <section className="verification-summary" aria-label="Verification summary">
        <article className="verification-summary__primary"><ShieldAlert aria-hidden="true" /><div><span>Awaiting decision</span><strong>{pending.length}</strong><small>unverified listings</small></div></article>
        <article><ClipboardCheck aria-hidden="true" /><div><span>Ready for review</span><strong>{readyCount}</strong><small>all evidence signals present</small></div></article>
        <article><ShieldCheck aria-hidden="true" /><div><span>Approved network</span><strong>{verified.length}</strong><small>verified resources</small></div></article>
        <article><Clock3 aria-hidden="true" /><div><span>Review mode</span><strong>Manual</strong><small>one explicit decision at a time</small></div></article>
      </section>

      <section className="verification-layout">
        <article className="panel verification-queue" aria-labelledby="verification-queue-title">
          <header className="verification-queue__header">
            <div><span className="eyebrow"><ScanLine aria-hidden="true" /> Evidence queue</span><h2 id="verification-queue-title">Pending listings</h2></div>
            <label className="search-field" htmlFor="verification-search">
              <Search aria-hidden="true" />
              <span className="sr-only">Search pending listings</span>
              <input id="verification-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search owner, resource, cluster…" />
            </label>
          </header>

          {feedback ? <div className="inline-notice" role="status"><Check aria-hidden="true" /> {feedback}</div> : null}

          {queue.length ? (
            <div className="verification-list">
              {queue.map((resource) => {
                const checks = reviewChecks(resource);
                const passed = checks.filter((check) => check.passed).length;
                const capabilities = Array.isArray(resource.capabilities) ? resource.capabilities : [];
                const tags = Array.isArray(resource.tags) ? resource.tags : [];
                return (
                  <article className="verification-card" key={resource.id}>
                    <header className="verification-card__header">
                      <span className="verification-card__mark"><Factory aria-hidden="true" /></span>
                      <div>
                        <span className="verification-card__reference">{resource.id} · {resource.category}</span>
                        <h3>{resource.name}</h3>
                        <p><MapPin aria-hidden="true" /> {resource.cluster || "Cluster not provided"}</p>
                      </div>
                      <span className="status-badge status-badge--pending"><Clock3 aria-hidden="true" /> Pending</span>
                    </header>

                    <div className="verification-card__owner">
                      <UserRoundCheck aria-hidden="true" />
                      <div><span>Submitted by</span><strong>{resource.ownerName || "Owner identity missing"}</strong><code>{resource.ownerId || "No owner ID"}</code></div>
                      <div className="verification-card__price"><span>Daily rate</span><strong>{currencyFormatter.format(Number(resource.pricePerDay) || 0)}</strong></div>
                    </div>

                    <p className="verification-card__description">{resource.description || "No production description was supplied."}</p>

                    {(capabilities.length || tags.length) ? (
                      <div className="evidence-tags" aria-label="Capabilities and tags">
                        {[...new Set([...capabilities, ...tags])].slice(0, 6).map((tag) => <span key={tag}>{tag}</span>)}
                      </div>
                    ) : null}

                    <div className="review-evidence">
                      <div className="review-evidence__heading">
                        <span>Evidence completeness</span>
                        <strong>{passed}/{checks.length} signals</strong>
                      </div>
                      <div className={`review-score review-score--${passed}`} aria-label={`${passed} of ${checks.length} evidence checks passed`}><span /></div>
                      <ul>
                        {checks.map(({ label, passed: checkPassed, icon: Icon }) => (
                          <li className={checkPassed ? "is-passed" : "is-missing"} key={label}>
                            <Icon aria-hidden="true" /> <span>{label}</span> {checkPassed ? <CheckCircle2 aria-label="Passed" /> : <AlertTriangle aria-label="Needs attention" />}
                          </li>
                        ))}
                      </ul>
                    </div>

                    <footer className="verification-card__footer">
                      <p><ShieldCheck aria-hidden="true" /> Approval makes this resource eligible for trusted matches and booking.</p>
                      <div>
                        <button className="button button--ghost" type="button" disabled={Boolean(working)} onClick={() => decide(resource, false)}>
                          <X aria-hidden="true" /> {working === `${resource.id}:return` ? "Returning…" : "Return for changes"}
                        </button>
                        <button className="button button--primary" type="button" disabled={Boolean(working)} onClick={() => decide(resource, true)}>
                          <ShieldCheck aria-hidden="true" /> {working === `${resource.id}:approve` ? "Approving…" : "Approve listing"}
                        </button>
                      </div>
                    </footer>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="empty-state empty-state--feature">
              <ShieldCheck aria-hidden="true" />
              <h3>{pending.length ? "No listings match that search" : "The trust queue is clear"}</h3>
              <p>{pending.length ? "Try a resource name, owner, category, or cluster." : "Every current resource has a verification decision."}</p>
            </div>
          )}
        </article>

        <aside className="verification-protocol">
          <span className="eyebrow"><ClipboardCheck aria-hidden="true" /> Review protocol</span>
          <h2>Trust is a production input.</h2>
          <p>Use the supplied evidence as a screening aid. Verification is an explicit administrator decision, not an automated score.</p>
          <ol>
            <li><span>01</span><div><strong>Confirm identity</strong><p>Match the resource to its registered owner profile.</p></div></li>
            <li><span>02</span><div><strong>Inspect capability</strong><p>Check that the description supports the category and use case.</p></div></li>
            <li><span>03</span><div><strong>Validate readiness</strong><p>Review pricing, health, availability, and cluster details.</p></div></li>
            <li><span>04</span><div><strong>Record a decision</strong><p>Approve only when the supplied evidence is internally consistent.</p></div></li>
          </ol>
          <div className="protocol-warning"><AlertTriangle aria-hidden="true" /><span><strong>Admin boundary</strong><small>You can change verification status only. Listing content remains owner-controlled.</small></span></div>
        </aside>
      </section>
    </div>
  );
}
