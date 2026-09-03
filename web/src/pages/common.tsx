import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

export function useResource<T>(path: string): { data: T | undefined; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .get<T>(path)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, reload, loading };
}

export function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="copy">
      <code title={value}>{value}</code>
      <button
        className="small"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          });
        }}
      >
        {done ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

export function fmtTs(ts: string): string {
  const d = new Date(Number(ts.split(".")[0]) * 1000);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function slackThreadUrl(channel: string, ts: string): string {
  return `https://slack.com/app_redirect?channel=${channel}&message_ts=${ts}`;
}
