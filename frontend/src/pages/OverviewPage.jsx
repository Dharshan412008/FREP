import {
  ArrowRight,
  Bell,
  Boxes,
  CalendarClock,
  CheckCircle2,
  CircleGauge,
  Factory,
  IndianRupee,
  MapPin,
  Network,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";

const numberFormatter = new Intl.NumberFormat("en-IN");
const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

function displayNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numberFormatter.format(numeric) : "—";
}

function displayCurrency(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? currencyFormatter.format(numeric) : "—";
}

function notificationIcon(kind) {
  if (kind === "booking") return CalendarClock;
  if (kind === "approval" || kind === "verification") return ShieldCheck;
  return Sparkles;
}

export default function OverviewPage({
  dashboard = {},
  resources = [],
  notifications = [],
  userRole = "buyer",
  onNavigate,
}) {
  const safeResources = Array.isArray(resources) ? resources : [];
  const safeNotifications = Array.isArray(notifications) ? notifications : [];
  const listed = Number(dashboard?.resources_listed) || safeResources.length;
  const available = Number(dashboard?.available_resources)
    || safeResources.filter((resource) => resource.availability).length;
  const availabilityRate = listed ? Math.round((available / listed) * 100) : 0;
  const verified = Number(dashboard?.verified_msmes)
    || safeResources.filter((resource) => resource.verified).length;
  const verifiedRate = listed ? Math.round((verified / listed) * 100) : 0;

  const highlights = [...safeResources]
    .sort((left, right) => {
      const leftSignal = Number(left.availability) + Number(left.verified) + (Number(left.rating) || 0) / 5;
      const rightSignal = Number(right.availability) + Number(right.verified) + (Number(right.rating) || 0) / 5;
      return rightSignal - leftSignal;
    })
    .slice(0, 3);

  const roleAction = userRole === "owner"
    ? { view: "listings", label: "Manage my listings" }
    : userRole === "admin"
      ? { view: "verification", label: "Review verification queue" }
      : { view: "planner", label: "Build a production plan" };

  const metrics = [
    {
      label: "Resources listed",
      value: displayNumber(dashboard?.resources_listed ?? safeResources.length),
      detail: `${verifiedRate}% network verified`,
      icon: Boxes,
      tone: "violet",
    },
    {
      label: "Available now",
      value: displayNumber(dashboard?.available_resources ?? available),
      detail: `${availabilityRate}% ready to deploy`,
      icon: Zap,
      tone: "mint",
    },
    {
      label: "Active bookings",
      value: displayNumber(dashboard?.active_bookings),
      detail: "Across shared capacity",
      icon: CalendarClock,
      tone: "amber",
    },
    {
      label: "Pending review",
      value: displayNumber(dashboard?.pending_verifications),
      detail: "Awaiting network approval",
      icon: ShieldCheck,
      tone: "blue",
    },
  ];

  return (
    <div className="page-stack overview-page">
      <section className="overview-hero" aria-labelledby="overview-title">
        <div className="overview-hero__copy">
          <span className="eyebrow"><Factory aria-hidden="true" /> Live factory network</span>
          <h1 id="overview-title">Turn idle capacity into production momentum.</h1>
          <p>
            Discover verified industrial resources, coordinate bundled jobs, and move
            production forward without fresh capital expenditure.
          </p>
          <div className="overview-hero__actions">
            <button className="button button--primary" type="button" onClick={() => onNavigate?.("marketplace")}>
              Explore capacity <ArrowRight aria-hidden="true" />
            </button>
            <button className="button button--ghost" type="button" onClick={() => onNavigate?.(roleAction.view)}>
              {roleAction.label}
            </button>
          </div>
        </div>

        <div className="network-pulse" aria-label={`${availabilityRate}% of listed resources are available`}>
          <div className="network-pulse__orbit network-pulse__orbit--outer" aria-hidden="true" />
          <div className="network-pulse__orbit network-pulse__orbit--inner" aria-hidden="true" />
          <div className="network-pulse__core">
            <CircleGauge aria-hidden="true" />
            <strong>{availabilityRate}%</strong>
            <span>capacity online</span>
          </div>
          <span className="network-pulse__node network-pulse__node--one" aria-hidden="true" />
          <span className="network-pulse__node network-pulse__node--two" aria-hidden="true" />
          <span className="network-pulse__node network-pulse__node--three" aria-hidden="true" />
        </div>
      </section>

      <section className="metric-grid" aria-label="Network summary">
        {metrics.map(({ label, value, detail, icon: Icon, tone }) => (
          <article className={`metric-card metric-card--${tone}`} key={label}>
            <div className="metric-card__icon"><Icon aria-hidden="true" /></div>
            <div className="metric-card__content">
              <span>{label}</span>
              <strong>{value}</strong>
              <small>{detail}</small>
            </div>
          </article>
        ))}
      </section>

      <section className="overview-grid">
        <article className="panel panel--capacity">
          <header className="panel__header">
            <div>
              <span className="eyebrow"><Zap aria-hidden="true" /> Ready capacity</span>
              <h2>High-signal resources</h2>
            </div>
            <button className="text-button" type="button" onClick={() => onNavigate?.("marketplace")}>
              View marketplace <ArrowRight aria-hidden="true" />
            </button>
          </header>

          {highlights.length ? (
            <div className="capacity-list">
              {highlights.map((resource) => (
                <article className="capacity-row" key={resource.id}>
                  <div className="capacity-row__mark" aria-hidden="true">
                    {String(resource.category || "R").slice(0, 1)}
                  </div>
                  <div className="capacity-row__main">
                    <div className="capacity-row__title">
                      <h3>{resource.name}</h3>
                      {resource.verified && <ShieldCheck aria-label="Verified resource" />}
                    </div>
                    <p><MapPin aria-hidden="true" /> {resource.cluster || "Cluster not listed"}</p>
                  </div>
                  <div className="capacity-row__meta">
                    <strong>{displayCurrency(resource.pricePerDay)}</strong>
                    <span>per day</span>
                  </div>
                  <span className={`status-dot ${resource.availability ? "status-dot--online" : "status-dot--paused"}`}>
                    {resource.availability ? "Available" : "Reserved"}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state empty-state--compact">
              <Boxes aria-hidden="true" />
              <h3>No capacity listed yet</h3>
              <p>New verified resources will appear here.</p>
            </div>
          )}
        </article>

        <aside className="panel panel--activity" aria-labelledby="activity-heading">
          <header className="panel__header">
            <div>
              <span className="eyebrow"><Bell aria-hidden="true" /> Signal feed</span>
              <h2 id="activity-heading">Network activity</h2>
            </div>
            <span className="live-chip"><span aria-hidden="true" /> Live</span>
          </header>

          {safeNotifications.length ? (
            <ol className="activity-feed">
              {safeNotifications.slice(0, 4).map((notification, index) => {
                const Icon = notificationIcon(notification.kind);
                return (
                  <li className="activity-feed__item" key={notification.id || `${notification.title}-${index}`}>
                    <div className={`activity-feed__icon activity-feed__icon--${notification.kind || "insight"}`}>
                      <Icon aria-hidden="true" />
                    </div>
                    <div>
                      <strong>{notification.title}</strong>
                      <p>{notification.detail}</p>
                      {notification.created_at || notification.created ? (
                        <time>{notification.created_at || notification.created}</time>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="empty-state empty-state--compact">
              <CheckCircle2 aria-hidden="true" />
              <h3>Everything is current</h3>
              <p>There are no new network alerts.</p>
            </div>
          )}
        </aside>
      </section>

      <section className="impact-strip" aria-label="Marketplace impact">
        <div className="impact-strip__intro">
          <span className="eyebrow"><Network aria-hidden="true" /> Shared infrastructure</span>
          <h2>More output. Less stranded capital.</h2>
        </div>
        <div className="impact-strip__metric">
          <IndianRupee aria-hidden="true" />
          <div><strong>{displayCurrency(dashboard?.average_cost_per_day)}</strong><span>average daily access</span></div>
        </div>
        <div className="impact-strip__metric">
          <Factory aria-hidden="true" />
          <div><strong>{displayNumber(dashboard?.capex_avoided)}k</strong><span>estimated capex avoided</span></div>
        </div>
        <button className="button button--secondary" type="button" onClick={() => onNavigate?.("analytics")}>
          See impact data <ArrowRight aria-hidden="true" />
        </button>
      </section>
    </div>
  );
}
