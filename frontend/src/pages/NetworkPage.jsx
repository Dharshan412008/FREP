import {
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  Compass,
  Factory,
  Map,
  MapPin,
  Network,
  Radio,
  ShieldCheck,
  Zap,
} from "lucide-react";

const numberFormatter = new Intl.NumberFormat("en-IN");

function shortLabel(value, maxLength = 16) {
  const label = String(value || "Cluster");
  return label.length > maxLength ? `${label.slice(0, maxLength - 1)}…` : label;
}

function nodePosition(index, count) {
  if (count <= 1) return { x: 400, y: 108 };
  const angle = (-Math.PI / 2) + (index / count) * Math.PI * 2;
  return {
    x: 400 + Math.cos(angle) * 282,
    y: 212 + Math.sin(angle) * 142,
  };
}

export default function NetworkPage({ clusters = [], resources = [], onCluster }) {
  const safeClusters = Array.isArray(clusters) ? clusters : [];
  const safeResources = Array.isArray(resources) ? resources : [];
  const directoryNames = new Set(safeClusters.map((cluster) => cluster.name));
  const directory = [
    ...safeClusters,
    ...safeResources
      .filter((resource) => resource.cluster && !directoryNames.has(resource.cluster))
      .filter((resource, index, list) => list.findIndex((item) => item.cluster === resource.cluster) === index)
      .map((resource) => ({ name: resource.cluster, city: resource.cluster, state: "", region: "Emerging" })),
  ];

  const clusterData = directory.map((cluster) => {
    const assets = safeResources.filter((resource) => resource.cluster === cluster.name);
    const available = assets.filter((resource) => resource.availability).length;
    const verified = assets.filter((resource) => resource.verified).length;
    const trustValues = assets.map((resource) => Number(resource.trustScore)).filter(Number.isFinite);
    const averageTrust = trustValues.length
      ? Math.round(trustValues.reduce((sum, score) => sum + score, 0) / trustValues.length)
      : null;
    return {
      ...cluster,
      assets,
      available,
      verified,
      averageTrust,
      categories: [...new Set(assets.map((resource) => resource.category).filter(Boolean))],
    };
  }).sort((left, right) => right.assets.length - left.assets.length || left.name.localeCompare(right.name));

  const availableTotal = safeResources.filter((resource) => resource.availability).length;
  const verifiedTotal = safeResources.filter((resource) => resource.verified).length;
  const regions = new Set(clusterData.map((cluster) => cluster.region).filter(Boolean));
  const leadingCluster = clusterData[0];

  const openCluster = (name) => onCluster?.(name);
  const handleNodeKeyDown = (event, name) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openCluster(name);
    }
  };

  return (
    <div className="page-stack network-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow"><Network aria-hidden="true" /> Industrial graph</span>
          <h1>Factory network</h1>
          <p>Navigate the manufacturing clusters connected through shared capacity, trust, and logistics.</p>
        </div>
        <div className="network-status-card">
          <span className="network-status-card__signal"><Radio aria-hidden="true" /></span>
          <div><small>Network status</small><strong>{availableTotal} resources online</strong></div>
          <span className="live-chip"><span aria-hidden="true" /> Live</span>
        </div>
      </header>

      <section className="network-summary" aria-label="Network summary">
        <article><MapPin aria-hidden="true" /><div><strong>{numberFormatter.format(clusterData.length)}</strong><span>connected clusters</span></div></article>
        <article><Boxes aria-hidden="true" /><div><strong>{numberFormatter.format(safeResources.length)}</strong><span>listed resources</span></div></article>
        <article><Zap aria-hidden="true" /><div><strong>{numberFormatter.format(availableTotal)}</strong><span>available today</span></div></article>
        <article><ShieldCheck aria-hidden="true" /><div><strong>{numberFormatter.format(verifiedTotal)}</strong><span>verified assets</span></div></article>
      </section>

      <section className="network-layout">
        <article className="panel network-visual-panel">
          <header className="panel__header">
            <div>
              <span className="eyebrow"><Compass aria-hidden="true" /> Capacity constellation</span>
              <h2>Connected production hubs</h2>
            </div>
            <span className="map-key"><i aria-hidden="true" /> Node size follows listed capacity</span>
          </header>

          {clusterData.length ? (
            <svg className="network-map" viewBox="0 0 800 430" role="img" aria-labelledby="network-map-title network-map-description">
              <title id="network-map-title">Interactive industrial cluster network</title>
              <desc id="network-map-description">Select a cluster node to browse its available resources.</desc>
              <g className="network-map__terrain" aria-hidden="true">
                <path d="M58 135 C160 36 296 68 359 119 S541 197 742 93" />
                <path d="M42 318 C182 218 291 350 407 291 S607 196 762 301" />
                <ellipse cx="400" cy="212" rx="334" ry="177" />
              </g>
              <g className="network-map__links" aria-hidden="true">
                {clusterData.map((cluster, index) => {
                  const position = nodePosition(index, clusterData.length);
                  return <line key={cluster.name} x1="400" y1="212" x2={position.x} y2={position.y} />;
                })}
              </g>
              <g className="network-map__hub" aria-hidden="true">
                <circle className="network-map__hub-ring network-map__hub-ring--outer" cx="400" cy="212" r="61" />
                <circle className="network-map__hub-ring network-map__hub-ring--inner" cx="400" cy="212" r="44" />
                <Factory x="383" y="188" width="34" height="34" />
                <text x="400" y="239" textAnchor="middle">FREP GRID</text>
              </g>
              <g>
                {clusterData.map((cluster, index) => {
                  const position = nodePosition(index, clusterData.length);
                  const radius = Math.min(39, 25 + cluster.assets.length * 3);
                  return (
                    <g
                      className="network-map__node"
                      key={cluster.name}
                      role="button"
                      tabIndex="0"
                      aria-label={`Browse ${cluster.name}, ${cluster.assets.length} resources, ${cluster.available} available`}
                      onClick={() => openCluster(cluster.name)}
                      onKeyDown={(event) => handleNodeKeyDown(event, cluster.name)}
                    >
                      <circle className="network-map__node-pulse" cx={position.x} cy={position.y} r={radius + 9} />
                      <circle className="network-map__node-disc" cx={position.x} cy={position.y} r={radius} />
                      <text className="network-map__node-value" x={position.x} y={position.y + 2} textAnchor="middle">{cluster.assets.length}</text>
                      <text className="network-map__node-label" x={position.x} y={position.y + radius + 20} textAnchor="middle">{shortLabel(cluster.name)}</text>
                    </g>
                  );
                })}
              </g>
            </svg>
          ) : (
            <div className="empty-state">
              <Map aria-hidden="true" />
              <h3>No clusters connected yet</h3>
              <p>The network graph will activate as cluster records are added.</p>
            </div>
          )}
        </article>

        <aside className="panel corridor-panel">
          <span className="eyebrow"><Zap aria-hidden="true" /> Corridor pulse</span>
          <h2>Network signals</h2>
          {leadingCluster ? (
            <>
              <div className="corridor-panel__feature">
                <span>Most connected</span>
                <strong>{leadingCluster.name}</strong>
                <p>{leadingCluster.assets.length} resources · {leadingCluster.available} available now</p>
              </div>
              <dl className="corridor-stats">
                <div><dt>Regions represented</dt><dd>{regions.size || 1}</dd></div>
                <div><dt>Network availability</dt><dd>{safeResources.length ? Math.round((availableTotal / safeResources.length) * 100) : 0}%</dd></div>
                <div><dt>Verified coverage</dt><dd>{safeResources.length ? Math.round((verifiedTotal / safeResources.length) * 100) : 0}%</dd></div>
              </dl>
              <button className="button button--secondary button--full" type="button" onClick={() => openCluster(leadingCluster.name)}>
                Open leading hub <ArrowUpRight aria-hidden="true" />
              </button>
            </>
          ) : (
            <div className="empty-state empty-state--compact"><Network aria-hidden="true" /><p>Signals will appear when resources connect.</p></div>
          )}
        </aside>
      </section>

      <section className="cluster-directory" aria-labelledby="cluster-directory-title">
        <header className="section-heading">
          <div><span className="eyebrow"><MapPin aria-hidden="true" /> Cluster directory</span><h2 id="cluster-directory-title">Browse by production hub</h2></div>
          <p>{clusterData.length} hubs across {regions.size || 1} industrial regions</p>
        </header>

        {clusterData.length ? (
          <div className="cluster-card-grid">
            {clusterData.map((cluster) => (
              <button className="cluster-card" type="button" key={cluster.name} onClick={() => openCluster(cluster.name)}>
                <span className="cluster-card__topline">
                  <span className="cluster-card__region">{cluster.region || cluster.state || "Industrial hub"}</span>
                  <ArrowUpRight aria-hidden="true" />
                </span>
                <span className="cluster-card__title">{cluster.name}</span>
                <span className="cluster-card__location"><MapPin aria-hidden="true" /> {[cluster.city, cluster.state].filter(Boolean).join(", ") || "Location listed in network"}</span>
                <span className="cluster-card__stats">
                  <span><strong>{cluster.assets.length}</strong> resources</span>
                  <span><strong>{cluster.available}</strong> online</span>
                  <span><strong>{cluster.averageTrust ?? "—"}</strong> trust</span>
                </span>
                <span className="cluster-card__categories">
                  {cluster.categories.length
                    ? cluster.categories.slice(0, 3).map((category) => <span key={category}>{category}</span>)
                    : <span>Capacity incoming</span>}
                </span>
                <span className="cluster-card__verification"><CheckCircle2 aria-hidden="true" /> {cluster.verified} verified assets</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
