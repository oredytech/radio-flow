// Server-time drift sync. The single source of truth for "now".
import { supabase } from "@/integrations/supabase/client";

let drift = 0; // ms; clientNow - serverNow
let lastSync = 0;
let syncing: Promise<void> | null = null;

const TIME_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/time`;

async function fetchServerNow(): Promise<number> {
  const res = await fetch(TIME_URL, {
    headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
    cache: "no-store",
  });
  const data = await res.json();
  return data.server_timestamp as number;
}

export async function syncServerTime(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const t0 = Date.now();
      const server = await fetchServerNow();
      const t1 = Date.now();
      const rtt = t1 - t0;
      // Best estimate: server time at moment we received the response is server + rtt/2
      const serverAtRecv = server + rtt / 2;
      drift = t1 - serverAtRecv;
      lastSync = t1;
    } catch (e) {
      console.warn("[time] sync failed", e);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

export function serverNow(): number {
  return Date.now() - drift;
}

export function getDrift(): number {
  return drift;
}

export function lastSyncAt(): number {
  return lastSync;
}

// Periodic background sync
let intervalId: ReturnType<typeof setInterval> | null = null;
export function startTimeSync(intervalMs = 30000) {
  if (intervalId) return;
  syncServerTime();
  intervalId = setInterval(syncServerTime, intervalMs);
}

// Avoid unused import warning
void supabase;
