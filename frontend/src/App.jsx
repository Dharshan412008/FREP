import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Bell,
  BookOpenCheck,
  Boxes,
  Building2,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CircleGauge,
  Factory,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Network,
  PanelLeftClose,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  UserRoundCheck,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import CopilotDrawer from "./components/CopilotDrawer";
import { useWorkspace } from "./hooks/useWorkspace";
import {
  createBooking,
  createResource,
  deleteResource,
  getSession,
  login,
  logout,
  patchBooking,
  patchResource,
} from "./lib/api";
import AnalyticsPage from "./pages/AnalyticsPage";
import BookingsPage from "./pages/BookingsPage";
import ListingsPage from "./pages/ListingsPage";
import MarketplacePage from "./pages/MarketplacePage";
import NetworkPage from "./pages/NetworkPage";
import OverviewPage from "./pages/OverviewPage";
import PlannerPage from "./pages/PlannerPage";
import VerificationPage from "./pages/VerificationPage";

const NAVIGATION = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, roles: ["buyer", "owner", "admin"] },
  { id: "marketplace", label: "Exchange", icon: Search, roles: ["buyer", "owner", "admin"] },
  { id: "planner", label: "Production plan", icon: Boxes, roles: ["buyer"] },
  { id: "network", label: "Cluster network", icon: Network, roles: ["buyer", "owner", "admin"] },
  { id: "bookings", label: "Bookings", icon: CalendarClock, roles: ["buyer"] },
  { id: "listings", label: "My listings", icon: Factory, roles: ["owner"] },
  { id: "verification", label: "Verification", icon: UserRoundCheck, roles: ["admin"] },
  { id: "analytics", label: "Intelligence", icon: BarChart3, roles: ["buyer", "owner", "admin"] },
];

const ROLE_LABELS = { buyer: "Capacity buyer", owner: "Resource owner", admin: "Network admin" };

function Brand({ compact = false }) {
  return (
    <div className={`brand-lockup ${compact ? "brand-lockup--compact" : ""}`}>
      <span className="brand-glyph" aria-hidden="true"><Factory size={22} strokeWidth={2.2} /></span>
      {!compact && (
        <span>
          <strong>FREP</strong>
          <small>Factory Resource Exchange</small>
        </span>
      )}
    </div>
  );
}

function ThemeButton({ theme, onToggle, className = "" }) {
  return (
    <button className={`icon-button ${className}`} onClick={onToggle} type="button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
      {theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
    </button>
  );
}

function LoginScreen({ theme, onToggleTheme, onAuthenticated }) {
  const [credentials, setCredentials] = useState({ username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const chooseDemo = (username) => {
    setCredentials({ username, password: `${username}123` });
    setError("");
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await login(credentials.username, credentials.password);
      onAuthenticated(response.user);
    } catch (requestError) {
      setError(requestError.message || "Could not sign in.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-screen">
      <div className="blueprint-grid" aria-hidden="true" />
      <header className="login-topbar">
        <Brand />
        <ThemeButton theme={theme} onToggle={onToggleTheme} />
      </header>

      <section className="login-story" aria-label="Platform introduction">
        <div className="login-story__copy">
          <span className="eyebrow"><span className="status-dot" /> India’s industrial capacity network</span>
          <h1>Make idle capacity<br /><em>move.</em></h1>
          <p>Find verified machines, operators, labs, and logistics across India’s manufacturing clusters—then turn a production brief into an actionable resource chain.</p>
          <div className="login-proof">
            <span><ShieldCheck size={18} /> Verified exchange</span>
            <span><Zap size={18} /> Local-first AI</span>
            <span><Network size={18} /> 25 cluster hubs</span>
          </div>
        </div>

        <div className="capacity-orbit" aria-hidden="true">
          <div className="orbit-ring orbit-ring--outer" />
          <div className="orbit-ring orbit-ring--inner" />
          <div className="orbit-core"><Factory size={34} /><strong>LIVE</strong><span>capacity</span></div>
          <div className="orbit-node orbit-node--one"><span>CNC</span><strong>80%</strong></div>
          <div className="orbit-node orbit-node--two"><span>Testing</span><strong>12 labs</strong></div>
          <div className="orbit-node orbit-node--three"><span>Logistics</span><strong>34 lanes</strong></div>
        </div>

        <div className="login-ticker">
          <span>PEENYA</span><i /> <span>BHOSARI</span><i /> <span>CHENNAI</span><i /> <span>TIRUPUR</span><i /> <span>AHMEDABAD</span>
        </div>
      </section>

      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-panel__inner">
          <span className="section-index">01 / ACCESS</span>
          <h2 id="login-title">Enter the exchange floor</h2>
          <p>Choose a demo role or use your workspace credentials.</p>

          <div className="demo-role-grid" aria-label="Choose demo account">
            {[
              ["buyer", "Buyer", "Find & book"],
              ["owner", "Owner", "List capacity"],
              ["admin", "Admin", "Verify network"],
            ].map(([username, title, caption]) => (
              <button className={credentials.username === username ? "is-selected" : ""} onClick={() => chooseDemo(username)} type="button" key={username}>
                <span>{username === "buyer" ? <Search size={18} /> : username === "owner" ? <Factory size={18} /> : <ShieldCheck size={18} />}</span>
                <strong>{title}</strong>
                <small>{caption}</small>
                <CheckCircle2 className="demo-role-check" size={16} />
              </button>
            ))}
          </div>

          <form className="login-form" onSubmit={submit}>
            <label>
              <span>Username</span>
              <input value={credentials.username} onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))} autoComplete="username" required placeholder="buyer" />
            </label>
            <label>
              <span>Password</span>
              <input value={credentials.password} onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))} type="password" autoComplete="current-password" required placeholder="••••••••" />
            </label>
            {error && <div className="inline-alert inline-alert--error" role="alert">{error}</div>}
            <button className="button button--primary button--large" disabled={busy} type="submit">
              {busy ? "Opening workspace…" : "Enter workspace"} <ArrowRight size={18} />
            </button>
          </form>

          <p className="login-footnote"><ShieldCheck size={15} /> Signed demo sessions · Role boundaries enforced by the server</p>
        </div>
      </section>
    </main>
  );
}

function Toast({ toast, onDismiss }) {
  if (!toast) return null;
  return (
    <div className={`toast toast--${toast.kind || "info"}`} role="status">
      {toast.kind === "error" ? <Activity size={18} /> : <CheckCircle2 size={18} />}
      <span>{toast.message}</span>
      <button onClick={onDismiss} aria-label="Dismiss notification" type="button"><X size={16} /></button>
    </div>
  );
}

function LoadingWorkspace() {
  return (
    <div className="workspace-loading" role="status">
      <span className="loader-mark"><Factory size={26} /></span>
      <strong>Synchronizing the exchange</strong>
      <span>Loading live capacity, clusters, and network signals…</span>
      <div><i /><i /><i /></div>
    </div>
  );
}

function AppShell({ user, theme, onToggleTheme, onSignOut, onSessionExpired }) {
  const [view, setView] = useState("overview");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [cart, setCart] = useState([]);
  const [toast, setToast] = useState(null);
  const [marketplaceIntent, setMarketplaceIntent] = useState({ id: 0, filters: {} });
  const navigationSequence = useRef(0);
  const mobileMenuSheetRef = useRef(null);
  const mobileMenuCloseRef = useRef(null);
  const mobileMenuPreviousFocusRef = useRef(null);
  const workspace = useWorkspace(user, onSessionExpired);

  const navItems = useMemo(() => NAVIGATION.filter((item) => item.roles.includes(user.role)), [user.role]);
  useEffect(() => {
    if (!navItems.some((item) => item.id === view)) setView("overview");
  }, [navItems, view]);

  const notify = useCallback((message, kind = "info") => {
    setToast({ message, kind, id: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!mobileMenu) return undefined;
    mobileMenuPreviousFocusRef.current = document.activeElement;
    const frame = window.requestAnimationFrame(() => mobileMenuCloseRef.current?.focus());
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileMenu(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(mobileMenuSheetRef.current?.querySelectorAll(
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
      const previous = mobileMenuPreviousFocusRef.current;
      if (previous?.isConnected && !previous.closest?.("[inert]")) previous.focus();
    };
  }, [mobileMenu]);

  const toggleCart = (resourceId) => {
    setCart((current) => current.includes(resourceId) ? current.filter((id) => id !== resourceId) : [...current, resourceId]);
  };

  const book = async (resourceIds, label = "Resource") => {
    const response = await createBooking({ resourceIds });
    setCart((current) => current.filter((id) => !resourceIds.includes(id)));
    notify(`${label} booked · ${response.id}`, "success");
    await workspace.refresh(["dashboard", "resources", "bookings", "notifications", "analytics"]);
    return response;
  };

  const bookingAction = async (bookingId, action, rating) => {
    try {
      await patchBooking(bookingId, { action, rating });
      notify(action === "rate" ? "Rating recorded" : "Booking completed", "success");
      await workspace.refresh(["dashboard", "resources", "bookings", "notifications", "analytics"]);
    } catch (error) {
      notify(error.message, "error");
      throw error;
    }
  };

  const resourceCreate = async (payload) => {
    const response = await createResource(payload);
    notify("Listing created and sent for verification", "success");
    await workspace.refresh(["dashboard", "resources", "notifications"]);
    return response;
  };
  const resourcePatch = async (id, updates) => {
    const response = await patchResource(id, updates);
    notify("Resource updated", "success");
    await workspace.refresh(["dashboard", "resources", "notifications"]);
    return response;
  };
  const resourceDelete = async (id) => {
    const response = await deleteResource(id);
    notify("Resource removed", "success");
    await workspace.refresh(["dashboard", "resources", "notifications"]);
    return response;
  };
  const verifyResource = async (id, verified) => {
    const response = await patchResource(id, { verified });
    notify(verified ? "Listing approved" : "Listing returned to pending", "success");
    await workspace.refresh(["dashboard", "resources", "notifications"]);
    return response;
  };

  const navigate = (nextView, options = {}) => {
    const aliases = { match: "marketplace", admin: "verification" };
    const requestedView = aliases[nextView] || nextView;
    const permittedView = navItems.some((item) => item.id === requestedView)
      ? requestedView
      : "overview";
    if (permittedView === "marketplace") {
      navigationSequence.current += 1;
      setMarketplaceIntent({
        id: navigationSequence.current,
        filters: options.filters || (options.cluster ? { cluster: options.cluster } : {}),
      });
    }
    setView(permittedView);
    setMobileMenu(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const renderPage = () => {
    if (workspace.loading) return <LoadingWorkspace />;
    switch (view) {
      case "marketplace":
        return <MarketplacePage resources={workspace.resources} clusters={workspace.clusters} cart={cart} userRole={user.role} navigationIntent={marketplaceIntent} onToggleCart={toggleCart} onBook={book} onToast={notify} />;
      case "planner":
        return <PlannerPage clusters={workspace.clusters} onToast={notify} />;
      case "network":
        return <NetworkPage clusters={workspace.clusters} resources={workspace.resources} onCluster={(cluster) => navigate("marketplace", { cluster })} />;
      case "bookings":
        return <BookingsPage bookings={workspace.bookings} onAction={bookingAction} />;
      case "listings":
        return <ListingsPage resources={workspace.resources} user={user} clusters={workspace.clusters} onCreate={resourceCreate} onPatch={resourcePatch} onDelete={resourceDelete} onToast={notify} />;
      case "verification":
        return <VerificationPage resources={workspace.resources} onVerify={verifyResource} />;
      case "analytics":
        return <AnalyticsPage analytics={workspace.analytics} />;
      default:
        return <OverviewPage dashboard={workspace.dashboard} resources={workspace.resources} notifications={workspace.notifications} userRole={user.role} onNavigate={navigate} />;
    }
  };

  const currentNav = navItems.find((item) => item.id === view) || navItems[0];

  return (
    <div className={`app-layout ${railCollapsed ? "rail-is-collapsed" : ""}`}>
      <aside className="app-rail" inert={mobileMenu || copilotOpen ? true : undefined}>
        <div className="app-rail__brand"><Brand compact={railCollapsed} /></div>
        <nav className="app-nav" aria-label="Workspace navigation">
          <span className="app-nav__label">Exchange floor</span>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button className={view === item.id ? "is-active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => navigate(item.id)} type="button" key={item.id} title={railCollapsed ? item.label : undefined}>
                <Icon size={19} /> <span>{item.label}</span>
                {item.id === "bookings" && workspace.bookings.length > 0 && <small>{workspace.bookings.length}</small>}
              </button>
            );
          })}
        </nav>
        <div className="app-rail__foot">
          <button className="rail-copilot" onClick={() => setCopilotOpen(true)} type="button" aria-haspopup="dialog" aria-expanded={copilotOpen}>
            <span><Sparkles size={18} /></span>
            {!railCollapsed && <div><strong>Ask FREP</strong><small>Search or draft</small></div>}
          </button>
          <button className="rail-collapse" onClick={() => setRailCollapsed((value) => !value)} aria-label={railCollapsed ? "Expand navigation" : "Collapse navigation"} type="button">
            <PanelLeftClose size={18} /> {!railCollapsed && <span>Collapse rail</span>}
          </button>
        </div>
      </aside>

      <div className="app-main" inert={mobileMenu || copilotOpen ? true : undefined}>
        {!workspace.online && (
          <div className="offline-strip" role="status"><WifiOff size={16} /><strong>Offline read-only</strong><span>Showing the last available public network data. Writes are paused.</span></div>
        )}
        <header className="app-header">
          <div className="mobile-brand"><Brand compact /><button className="icon-button" onClick={() => setMobileMenu(true)} aria-label="Open menu" aria-controls="mobile-workspace-menu" aria-expanded={mobileMenu} type="button"><Menu size={20} /></button></div>
          <div className="page-identity">
            <span className="section-index">FREP / {String(currentNav.label).toUpperCase()}</span>
            <h1>{currentNav.label}</h1>
          </div>
          <button className="command-trigger" onClick={() => setCopilotOpen(true)} type="button" aria-haspopup="dialog" aria-expanded={copilotOpen}>
            <Search size={17} /><span>Ask AI or search</span><kbd>Ctrl K</kbd>
          </button>
          <div className="header-actions">
            <span className={`live-indicator live-indicator--${workspace.liveState}`} title={`Live updates: ${workspace.liveState}`}>
              {workspace.liveState === "offline" ? <WifiOff size={15} /> : <Wifi size={15} />}<span>{workspace.liveState === "live" ? "Live" : workspace.liveState}</span>
            </span>
            <ThemeButton theme={theme} onToggle={onToggleTheme} />
            <button className="icon-button notification-button" onClick={() => navigate("overview")} aria-label="View notifications" type="button"><Bell size={19} />{workspace.notifications.length ? <i /> : null}</button>
            <div className="profile-chip">
              <span>{user.name?.split(" ").map((part) => part[0]).slice(0, 2).join("") || "FX"}</span>
              <div><strong>{user.name}</strong><small>{ROLE_LABELS[user.role]}</small></div>
              <ChevronDown size={15} />
            </div>
            <button className="icon-button" onClick={onSignOut} aria-label="Sign out" title="Sign out" type="button"><LogOut size={18} /></button>
          </div>
        </header>

        {workspace.error && (
          <div className="workspace-alert" role="alert"><Activity size={17} /><span>{workspace.error}</span><button onClick={() => workspace.refresh(["all"], { initial: true })} type="button">Retry</button></div>
        )}
        <main className="page-stage" id="main-content">{renderPage()}</main>
      </div>

      <nav className="mobile-bottom-nav" aria-label="Mobile navigation" inert={mobileMenu || copilotOpen ? true : undefined}>
        {navItems.slice(0, 4).map((item) => {
          const Icon = item.icon;
          return <button className={view === item.id ? "is-active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => navigate(item.id)} type="button" key={item.id}><Icon size={19} /><span>{item.label.split(" ")[0]}</span></button>;
        })}
        <button onClick={() => setMobileMenu(true)} aria-controls="mobile-workspace-menu" aria-expanded={mobileMenu} type="button"><Menu size={19} /><span>More</span></button>
      </nav>

      <div id="mobile-workspace-menu" className={`mobile-menu ${mobileMenu ? "is-open" : ""}`} aria-hidden={!mobileMenu} inert={!mobileMenu ? true : undefined} role="dialog" aria-modal="true" aria-label="Workspace menu">
        <button className="drawer-scrim is-open" onClick={() => setMobileMenu(false)} aria-label="Close navigation" tabIndex="-1" type="button" />
        <div className="mobile-menu__sheet" ref={mobileMenuSheetRef}>
          <header><Brand /><button className="icon-button" ref={mobileMenuCloseRef} onClick={() => setMobileMenu(false)} aria-label="Close navigation" type="button"><X size={20} /></button></header>
          {navItems.map((item) => {
            const Icon = item.icon;
            return <button className={view === item.id ? "is-active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => navigate(item.id)} type="button" key={item.id}><Icon size={19} />{item.label}<ArrowRight size={16} /></button>;
          })}
          <button className="button button--secondary" onClick={() => { setMobileMenu(false); setCopilotOpen(true); }} type="button"><Sparkles size={17} /> Open Copilot</button>
          <button className="button button--ghost" onClick={() => { setMobileMenu(false); onSignOut(); }} type="button"><LogOut size={17} /> Sign out</button>
        </div>
      </div>

      <CopilotDrawer open={copilotOpen} onClose={() => setCopilotOpen(false)} user={user} onNavigate={(next, options) => { navigate(next, options); setCopilotOpen(false); }} onRefresh={workspace.refresh} onToast={notify} />
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState({ loading: true, user: null });
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("frep-react-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("frep-react-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b0d0f" : "#f2efe7");
  }, [theme]);

  useEffect(() => {
    getSession()
      .then((response) => setSession({ loading: false, user: response.authenticated ? response.user : null }))
      .catch(() => setSession({ loading: false, user: null }));
  }, []);

  useEffect(() => {
    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const openCopilot = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector(".command-trigger")?.click();
      }
    };
    window.addEventListener("keydown", openCopilot);
    return () => window.removeEventListener("keydown", openCopilot);
  }, []);

  const signOut = async () => {
    try {
      await logout();
    } finally {
      setSession({ loading: false, user: null });
    }
  };

  if (session.loading) {
    return <div className="app-boot"><Brand /><span className="boot-line" /><p>Connecting to the exchange…</p></div>;
  }

  return session.user ? (
    <AppShell user={session.user} theme={theme} onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")} onSignOut={signOut} onSessionExpired={() => setSession({ loading: false, user: null })} />
  ) : (
    <LoginScreen theme={theme} onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")} onAuthenticated={(user) => setSession({ loading: false, user })} />
  );
}
