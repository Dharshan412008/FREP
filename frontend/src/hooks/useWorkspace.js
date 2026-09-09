import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAiStatus,
  getAnalytics,
  getBookings,
  getClusters,
  getDashboard,
  getNotifications,
  getResources,
} from "../lib/api";

const initialData = {
  dashboard: null,
  resources: [],
  clusters: [],
  bookings: [],
  analytics: null,
  notifications: [],
  aiStatus: null,
};

export function useWorkspace(user, onUnauthorized) {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [liveState, setLiveState] = useState("connecting");
  const refreshTimer = useRef(null);

  const refresh = useCallback(
    async (scopes = ["all"], options = {}) => {
      if (!user) return;
      const all = scopes.includes("all");
      const tasks = [];
      const next = {};
      const failures = [];
      const queue = (key, loader) => {
        tasks.push(
          loader().then((value) => {
            next[key] = value;
          }).catch((requestError) => {
            failures.push(requestError);
          }),
        );
      };

      if (all || scopes.includes("dashboard")) queue("dashboard", getDashboard);
      if (all || scopes.includes("resources")) queue("resources", getResources);
      if (all || scopes.includes("clusters")) queue("clusters", getClusters);
      if (user.role === "buyer" && (all || scopes.includes("bookings"))) {
        queue("bookings", async () => {
          const bookings = await getBookings();
          if (!Array.isArray(bookings)) return [];
          const buyerName = String(user.name || "").trim().toLocaleLowerCase();
          return bookings.filter(
            (booking) =>
              String(booking?.buyer || "").trim().toLocaleLowerCase() === buyerName,
          );
        });
      }
      if (all || scopes.includes("analytics")) queue("analytics", getAnalytics);
      if (all || scopes.includes("notifications")) {
        queue("notifications", getNotifications);
      }
      if (all || scopes.includes("ai")) queue("aiStatus", getAiStatus);

      if (options.initial) setLoading(true);
      try {
        await Promise.all(tasks);
        if (failures.some((requestError) => requestError?.status === 401)) {
          onUnauthorized?.();
          return;
        }
        if (Object.keys(next).length) {
          setData((current) => ({ ...current, ...next }));
        }
        setError(
          failures.length
            ? failures[0]?.message || "Some workspace data could not be refreshed."
            : "",
        );
      } finally {
        if (options.initial) setLoading(false);
      }
    },
    [onUnauthorized, user],
  );

  useEffect(() => {
    setData(initialData);
    if (user) refresh(["all"], { initial: true });
  }, [refresh, user]);

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      refresh(["all"]);
    };
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [refresh]);

  useEffect(() => {
    if (!user || !online) {
      setLiveState("offline");
      return undefined;
    }
    const source = new EventSource("/api/events", { withCredentials: true });
    setLiveState("connecting");

    const scheduleRefresh = () => {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        refresh(["dashboard", "resources", "bookings", "notifications", "analytics"]);
      }, 180);
    };
    source.addEventListener("ready", () => setLiveState("live"));
    source.addEventListener("heartbeat", () => setLiveState("live"));
    source.addEventListener("notification", scheduleRefresh);
    source.addEventListener("reconnect", () => setLiveState("connecting"));
    source.onopen = () => setLiveState("live");
    source.onerror = () => setLiveState(navigator.onLine ? "connecting" : "offline");

    return () => {
      window.clearTimeout(refreshTimer.current);
      source.close();
    };
  }, [online, refresh, user]);

  return {
    ...data,
    loading,
    error,
    online,
    liveState,
    refresh,
  };
}
