import {
  Activity,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  CircleGauge,
  Factory,
  Info,
  Leaf,
  Route,
  TrendingUp,
  Truck,
} from "lucide-react";

const numberFormatter = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compactLabel(value, maxLength = 14) {
  const label = String(value || "Other");
  return label.length > maxLength ? `${label.slice(0, maxLength - 1)}…` : label;
}

function CategoryChart({ categories, listed, demand }) {
  const values = categories.map((category, index) => ({
    category,
    listed: number(listed[index]),
    demand: number(demand[index]),
  }));
  const width = 760;
  const height = 300;
  const left = 46;
  const right = 18;
  const top = 20;
  const bottom = 62;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = Math.max(1, ...values.flatMap((item) => [item.listed, item.demand]));
  const groupWidth = plotWidth / Math.max(values.length, 1);
  const barWidth = Math.min(28, Math.max(10, groupWidth * 0.28));
  const ticks = Array.from(
    { length: 5 },
    (_, index) => Number(((maxValue * index) / 4).toFixed(2)),
  );

  return (
    <svg className="data-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="category-chart-title category-chart-description">
      <title id="category-chart-title">Listed resources compared with booking demand by category</title>
      <desc id="category-chart-description">
        {values.map((item) => `${item.category}: ${item.listed} listed and ${item.demand} demanded`).join(". ")}
      </desc>
      <g className="data-chart__grid" aria-hidden="true">
        {ticks.map((tick, index) => {
          const y = top + plotHeight - (tick / maxValue) * plotHeight;
          return (
            <g key={`category-tick-${index}`}>
              <line x1={left} x2={width - right} y1={y} y2={y} />
              <text x={left - 10} y={y + 4} textAnchor="end">{numberFormatter.format(tick)}</text>
            </g>
          );
        })}
      </g>
      <g className="data-chart__bars">
        {values.map((item, index) => {
          const center = left + groupWidth * index + groupWidth / 2;
          const listedHeight = (item.listed / maxValue) * plotHeight;
          const demandHeight = (item.demand / maxValue) * plotHeight;
          return (
            <g key={item.category}>
              <rect
                className="data-chart__bar data-chart__bar--listed"
                x={center - barWidth - 2}
                y={top + plotHeight - listedHeight}
                width={barWidth}
                height={listedHeight}
                rx="5"
              >
                <title>{`${item.category}: ${item.listed} listed`}</title>
              </rect>
              <rect
                className="data-chart__bar data-chart__bar--demand"
                x={center + 2}
                y={top + plotHeight - demandHeight}
                width={barWidth}
                height={demandHeight}
                rx="5"
              >
                <title>{`${item.category}: ${item.demand} booking allocations`}</title>
              </rect>
              <text className="data-chart__label" x={center} y={height - 27} textAnchor="middle">
                {compactLabel(item.category)}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function TrendChart({ labels, periods, trend, movingAverage }) {
  const width = 760;
  const height = 300;
  const left = 42;
  const right = 24;
  const top = 28;
  const bottom = 48;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = labels.map((label, index) => ({
    label,
    period: periods[index] || label,
    value: number(trend[index]),
    average: number(movingAverage[index]),
  }));
  const maxValue = Math.max(1, ...values.flatMap((item) => [item.value, item.average]));
  const xFor = (index) => left + (values.length <= 1 ? plotWidth / 2 : (index / (values.length - 1)) * plotWidth);
  const yFor = (value) => top + plotHeight - (value / maxValue) * plotHeight;
  const points = values.map((item, index) => `${xFor(index)},${yFor(item.value)}`).join(" ");
  const averagePoints = values.map((item, index) => `${xFor(index)},${yFor(item.average)}`).join(" ");
  const areaPoints = values.length
    ? `${xFor(0)},${top + plotHeight} ${points} ${xFor(values.length - 1)},${top + plotHeight}`
    : "";
  const ticks = Array.from(
    { length: 5 },
    (_, index) => Number(((maxValue * index) / 4).toFixed(2)),
  );

  return (
    <svg className="data-chart data-chart--line" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="trend-chart-title trend-chart-description">
      <title id="trend-chart-title">Booking activity over the reporting window</title>
      <desc id="trend-chart-description">
        {values.map((item) => `${item.period}: ${item.value} bookings`).join(". ")}
      </desc>
      <g className="data-chart__grid" aria-hidden="true">
        {ticks.map((tick, index) => {
          const y = yFor(tick);
          return (
            <g key={`trend-tick-${index}`}>
              <line x1={left} x2={width - right} y1={y} y2={y} />
              <text x={left - 9} y={y + 4} textAnchor="end">{numberFormatter.format(tick)}</text>
            </g>
          );
        })}
      </g>
      {values.length ? (
        <g>
          <polygon className="data-chart__area" points={areaPoints} />
          <polyline className="data-chart__line data-chart__line--primary" points={points} />
          <polyline className="data-chart__line data-chart__line--average" points={averagePoints} />
          {values.map((item, index) => (
            <g key={item.period}>
              <circle className="data-chart__point-halo" cx={xFor(index)} cy={yFor(item.value)} r="9" />
              <circle className="data-chart__point" cx={xFor(index)} cy={yFor(item.value)} r="4">
                <title>{`${item.period}: ${item.value} bookings`}</title>
              </circle>
              <text className="data-chart__value" x={xFor(index)} y={yFor(item.value) - 15} textAnchor="middle">
                {item.value}
              </text>
              <text className="data-chart__label" x={xFor(index)} y={height - 18} textAnchor="middle">
                {item.label}
              </text>
            </g>
          ))}
        </g>
      ) : null}
    </svg>
  );
}

export default function AnalyticsPage({ analytics = {} }) {
  const categories = Array.isArray(analytics?.categories) ? analytics.categories : [];
  const listed = Array.isArray(analytics?.listed) ? analytics.listed : [];
  const demand = Array.isArray(analytics?.demand) ? analytics.demand : [];
  const trendLabels = Array.isArray(analytics?.trendLabels) ? analytics.trendLabels : [];
  const trendPeriods = Array.isArray(analytics?.trendPeriods) ? analytics.trendPeriods : [];
  const trend = Array.isArray(analytics?.trend) ? analytics.trend : [];
  const movingAverage = Array.isArray(analytics?.trendMovingAverage) ? analytics.trendMovingAverage : [];
  const carbon = analytics?.carbonBreakdown || {};
  const assumptions = analytics?.assumptions || {};
  const demandSummary = analytics?.demandBreakdown || {};
  const trendSummary = analytics?.trendBreakdown || {};
  const byCategory = Array.isArray(carbon.byCategory) ? carbon.byCategory : [];
  const proxyDistance = byCategory.reduce((total, item) => total + number(item.distanceProxyKm), 0);
  const statusCounts = Object.entries(trendSummary.statusCounts || {});
  const totalListed = listed.reduce((sum, value) => sum + number(value), 0);
  const totalDemand = demand.reduce((sum, value) => sum + number(value), 0);

  return (
    <div className="page-stack analytics-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow"><Activity aria-hidden="true" /> Network intelligence</span>
          <h1>Capacity analytics</h1>
          <p>See where shared infrastructure is active, where demand is building, and what utilization avoids.</p>
        </div>
        <div className="reporting-chip">
          <CalendarDays aria-hidden="true" />
          <span><small>Reporting window</small><strong>{trendPeriods[0] || "Current"} — {trendPeriods.at(-1) || "period"}</strong></span>
        </div>
      </header>

      <section className="analytics-summary" aria-label="Analytics summary">
        <article className="analytics-kpi analytics-kpi--violet">
          <BarChart3 aria-hidden="true" />
          <div><span>Listed capacity</span><strong>{numberFormatter.format(totalListed)}</strong><small>resources across {categories.length} categories</small></div>
        </article>
        <article className="analytics-kpi analytics-kpi--amber">
          <TrendingUp aria-hidden="true" />
          <div><span>Demand allocations</span><strong>{numberFormatter.format(totalDemand)}</strong><small>from {numberFormatter.format(number(demandSummary.bookingCount))} qualified bookings</small></div>
        </article>
        <article className="analytics-kpi analytics-kpi--mint">
          <Leaf aria-hidden="true" />
          <div><span>Realized impact</span><strong>{numberFormatter.format(number(analytics?.carbonSavings))} kg</strong><small>CO2e planning estimate</small></div>
        </article>
        <article className="analytics-kpi analytics-kpi--blue">
          <CircleGauge aria-hidden="true" />
          <div><span>Average utilization</span><strong>{numberFormatter.format(number(carbon.averageUtilizationPercent))}%</strong><small>completed allocation utilization</small></div>
        </article>
      </section>

      <section className="chart-grid">
        <article className="panel chart-panel">
          <header className="panel__header">
            <div>
              <span className="eyebrow"><Factory aria-hidden="true" /> Supply &amp; demand</span>
              <h2>Capacity by category</h2>
            </div>
            <div className="chart-legend" aria-label="Chart legend">
              <span><i className="legend-swatch legend-swatch--listed" aria-hidden="true" /> Listed</span>
              <span><i className="legend-swatch legend-swatch--demand" aria-hidden="true" /> Demand</span>
            </div>
          </header>
          {categories.length ? (
            <CategoryChart categories={categories} listed={listed} demand={demand} />
          ) : (
            <div className="empty-state"><BarChart3 aria-hidden="true" /><h3>No category data yet</h3><p>Supply and demand will appear after resources are listed.</p></div>
          )}
        </article>

        <article className="panel chart-panel">
          <header className="panel__header">
            <div>
              <span className="eyebrow"><TrendingUp aria-hidden="true" /> Booking velocity</span>
              <h2>Activity trend</h2>
            </div>
            <div className="chart-legend" aria-label="Chart legend">
              <span><i className="legend-swatch legend-swatch--trend" aria-hidden="true" /> Bookings</span>
              <span><i className="legend-line legend-line--average" aria-hidden="true" /> 3-month mean</span>
            </div>
          </header>
          {trendLabels.length ? (
            <TrendChart labels={trendLabels} periods={trendPeriods} trend={trend} movingAverage={movingAverage} />
          ) : (
            <div className="empty-state"><TrendingUp aria-hidden="true" /><h3>No trend data yet</h3><p>Booking activity will populate this reporting window.</p></div>
          )}
          {statusCounts.length ? (
            <div className="status-summary" aria-label="Booking statuses">
              {statusCounts.map(([status, count]) => <span key={status}><strong>{count}</strong> {status}</span>)}
            </div>
          ) : null}
        </article>
      </section>

      <section className="impact-dashboard" aria-labelledby="impact-title">
        <article className="impact-dashboard__hero">
          <div className="impact-dashboard__halo" aria-hidden="true"><Leaf /></div>
          <span className="eyebrow">Realized sharing impact</span>
          <h2 id="impact-title">{numberFormatter.format(number(analytics?.carbonSavings))} <small>kgCO2e</small></h2>
          <p>Estimated net emissions avoided by completed bookings after the freight proxy is deducted.</p>
          <span className="scope-chip"><CheckCircle2 aria-hidden="true" /> Completed bookings only</span>
        </article>

        <div className="impact-dashboard__metrics">
          <article><CheckCircle2 aria-hidden="true" /><span>Completed allocations</span><strong>{numberFormatter.format(number(carbon.bookingCount))}</strong></article>
          <article><Factory aria-hidden="true" /><span>Gross sharing credit</span><strong>{numberFormatter.format(number(carbon.grossAvoidedKg))} kg</strong></article>
          <article><Truck aria-hidden="true" /><span>Freight deduction</span><strong>{numberFormatter.format(number(carbon.transportEmissionsKg))} kg</strong></article>
          <article><Route aria-hidden="true" /><span>Distance proxy</span><strong>{numberFormatter.format(proxyDistance)} km</strong></article>
        </div>

        <aside className="method-card">
          <div className="method-card__icon"><Info aria-hidden="true" /></div>
          <div>
            <h3>How this estimate works</h3>
            <p>{assumptions?.carbonSavings?.formula || "Shared-capacity credit minus estimated transport emissions."}</p>
            <details>
              <summary>Method &amp; assumptions</summary>
              <div className="method-card__details">
                <p><strong>Utilization:</strong> {assumptions?.carbonSavings?.utilization || "Recorded utilization, with a disclosed fallback."}</p>
                <p><strong>Distance:</strong> {assumptions?.carbonSavings?.distanceProxy || "Transport cost is used as a distance proxy."}</p>
                <p><strong>Caveat:</strong> {assumptions?.carbonSavings?.caveat || "Planning estimate only; not an audited life-cycle assessment."}</p>
              </div>
            </details>
          </div>
        </aside>
      </section>
    </div>
  );
}
