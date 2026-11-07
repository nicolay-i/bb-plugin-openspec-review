import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { liveRequest } from "./live-request";

// Last result per key for this app session: reopening a tab or card paints at once while the read refreshes.
const cache = new Map<string, unknown>();
const CACHE_LIMIT = 50;
function remember(key: string, value: unknown) {
  cache.delete(key); cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** One in-flight read per mounted query. Invalidated generations cannot commit data. */
export function useLive<T>(load: (signal: AbortSignal) => Promise<T>, poll = true, key?: string) {
  const [data, setData] = useState<T | undefined>(() => key === undefined ? undefined : cache.get(key) as T | undefined);
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(() => key === undefined || !cache.has(key));
  // A reused component (e.g. the chat header after switching threads) must not keep showing the previous key's data.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key); setData(key === undefined ? undefined : cache.get(key) as T | undefined); setError(undefined); setLoading(key === undefined || !cache.has(key));
  }
  const request = useRef<() => void>(() => {});
  const refresh = useCallback(() => request.current(), []);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    const session = liveRequest(load, result => { if (key !== undefined) remember(key, result); setData(result); setError(undefined); }, setError, () => setLoading(false));
    const run = session.run;
    request.current = () => { void run(); };
    void run();
    const interval = poll ? setInterval(() => { if (document.visibilityState === "visible") void run(); }, 4000) : undefined;
    const visibility = () => { if (document.visibilityState === "visible") void run(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { session.dispose(); clearInterval(interval); document.removeEventListener("visibilitychange", visibility); request.current = () => {}; };
  }, [load, poll, connection, key]);
  useRealtime("changed", refresh);
  return { data, error, loading, refresh, stale: Boolean(error) || connection !== "connected" };
}
