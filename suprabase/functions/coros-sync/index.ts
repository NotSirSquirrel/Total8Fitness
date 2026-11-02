// Per-account COROS sync. Deploy: supabase functions deploy coros-sync
// Uses the unofficial COROS Training Hub API. The user's COROS password is used once to
// log in and is never stored; only the resulting access token is kept (coros_links table,
// not readable from the browser). Imported activities go to the caller's own
// user_data row (key corosActs), which the app already reads.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const BASES: Record<string, string> = {
  en: "https://teamapi.coros.com",
  eu: "https://teameuapi.coros.com",
  cn: "https://teamcnapi.coros.com",
};
const MIN_GAP_MS = 60_000; // per-user throttle between COROS calls
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class Fail extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

async function md5(s: string) {
  // Web Crypto has no MD5; use Deno's std wrapper.
  const { crypto: dc } = await import("https://deno.land/std@0.224.0/crypto/mod.ts");
  const buf = await dc.subtle.digest("MD5", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class Stale extends Error {}

async function coros(base: string, path: string, opts: { token?: string; body?: unknown; params?: Record<string, string | number> }) {
  const qs = opts.params ? "?" + new URLSearchParams(Object.entries(opts.params).map(([k, v]) => [k, String(v)])) : "";
  let res: Response;
  try {
    res = await fetch(base + path + qs, {
      method: opts.body !== undefined ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        ...(opts.token ? { accesstoken: opts.token } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Fail(502, "Couldn’t reach COROS. Try again in a bit.");
  }
  if ((res.status === 401 || res.status === 403) && opts.token) throw new Stale();
  if (res.status === 429) throw new Fail(429, "COROS is rate limiting requests. Try again in a few minutes.");
  if (!res.ok) throw new Fail(502, `COROS returned HTTP ${res.status}.`);
  const out = await res.json();
  if (out.result !== "0000") {
    // Expired/invalid tokens come back as an application-level error, not an HTTP one.
    if (opts.token) throw new Stale();
    throw new Fail(400, "COROS rejected that email or password. Use your COROS email login (not Google/Apple), and check the region.");
  }
  return out;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

async function fetchActs(base: string, token: string, startDay: string | null) {
  const start = startDay ?? ymd(new Date(Date.now() - 365 * 864e5));
  const end = ymd(new Date(Date.now() + 864e5));
  const items: any[] = [];
  for (let page = 1; page <= 50; page++) {
    const d = (await coros(base, "/activity/query", {
      token,
      params: { size: 200, pageNumber: page, modeList: "", startDay: start, endDay: end },
    })).data;
    items.push(...(d.dataList ?? []));
    if (page >= Number(d.totalPage ?? 1)) break;
  }
  return items;
}

function kind(sport: unknown, name: unknown) {
  const s = Number(sport ?? 0), n = String(name ?? "").toLowerCase();
  if (s === 104 || s === 105 || n.includes("hike")) return "Hike";
  if (s >= 100 && s < 200) return "Run";
  if (s >= 200 && s < 300) return "Cycle";
  if (s >= 300 && s < 400) return "Swim";
  if (s === 402 || n.includes("strength")) return "Strength";
  if (s === 900 || n.includes("walk")) return "Walk";
  return "Other";
}

function conv(a: any) {
  let d = String(a.date ?? "");
  d = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : new Date(a.startTime * 1000).toISOString().slice(0, 10);
  return {
    sid: String(a.labelId), d, t: kind(a.sportType, a.name), n: a.name || "Workout", m: a.distance || 0,
    s: a.workoutTime || a.totalTime || 0, k: Math.round((a.calorie || 0) / 1000), // COROS reports calories x1000
    h: a.avgHr || 0, el: a.ascent || 0, w: a.avgPower || 0, et: a.totalTime || 0, dv: a.device || "", st: a.sportType,
  };
}

async function loadStore(uid: string) {
  const { data, error } = await admin.from("user_data").select("value").eq("user_id", uid).eq("key", "corosActs").maybeSingle();
  if (error) throw new Fail(500, "Couldn’t read your saved workouts.");
  try { return data ? JSON.parse(data.value) : { acts: {} }; } catch { return { acts: {} }; }
}

async function syncNow(uid: string, link: { region: string; token: string }) {
  const base = BASES[link.region] ?? BASES.en;
  const store = await loadStore(uid);
  delete store.ctoken; // older versions kept the token here, where the browser could read it
  const last = store.last ? String(store.last) : null;
  const startDay = last
    ? ymd(new Date(Date.UTC(+last.slice(0, 4), +last.slice(4, 6) - 1, +last.slice(6, 8)) - 7 * 864e5))
    : null;

  let items: any[];
  try {
    items = await fetchActs(base, link.token, startDay);
  } catch (e) {
    if (e instanceof Stale) throw new Fail(409, "Your COROS connection expired. Reconnect to keep syncing.");
    throw e;
  }
  const acts = store.acts ?? {};
  let newest = Number(store.last ?? 0), added = 0;
  for (const a of items) {
    if (!a.labelId) continue;
    if (!acts[String(a.labelId)]) added++;
    acts[String(a.labelId)] = conv(a);
    newest = Math.max(newest, Number(a.date ?? 0));
  }
  const updated = new Date().toISOString();
  const { error } = await admin.from("user_data").upsert(
    { user_id: uid, key: "corosActs", value: JSON.stringify({ acts, last: newest, updated }), updated_at: updated },
    { onConflict: "user_id,key" },
  );
  if (error) throw new Fail(500, "Couldn’t save your workouts.");
  await admin.from("coros_links").update({ last_sync_at: updated }).eq("user_id", uid);
  return { fetched: items.length, added, total: Object.keys(acts).length, updated };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method !== "POST") throw new Fail(405, "POST only.");
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u?.user) throw new Fail(401, "Please sign in again.");
    const uid = u.user.id;
    const body = await req.json().catch(() => ({}));

    const { data: link } = await admin.from("coros_links").select("*").eq("user_id", uid).maybeSingle();

    if (body.action === "status") {
      return json({ linked: !!link, region: link?.region ?? null, email: link?.coros_email ?? null, lastSync: link?.last_sync_at ?? null });
    }

    if (body.action === "unlink") {
      await admin.from("coros_links").delete().eq("user_id", uid);
      return json({ linked: false });
    }

    if (link?.last_sync_at && Date.now() - Date.parse(link.last_sync_at) < MIN_GAP_MS && body.action === "sync") {
      return json({ throttled: true, lastSync: link.last_sync_at });
    }

    if (body.action === "link") {
      const email = String(body.email ?? "").trim(), password = String(body.password ?? "");
      const region = BASES[body.region] ? body.region : "en";
      if (!email || !password) throw new Fail(400, "Enter your COROS email and password.");
      const out = await coros(BASES[region], "/account/login", {
        body: { account: email, accountType: 2, pwd: await md5(password) },
      });
      const token = out.data?.accessToken;
      if (!token) throw new Fail(502, "COROS didn’t return a login token.");
      const { error } = await admin.from("coros_links").upsert(
        { user_id: uid, region, coros_email: email, token, last_sync_at: null },
        { onConflict: "user_id" },
      );
      if (error) throw new Fail(500, "Couldn’t save your COROS connection.");
      return json({ linked: true, ...(await syncNow(uid, { region, token })) });
    }

    if (body.action === "sync") {
      if (!link) throw new Fail(409, "Connect your COROS account first.");
      return json({ linked: true, ...(await syncNow(uid, link)) });
    }

    throw new Fail(400, "Unknown action.");
  } catch (e) {
    if (e instanceof Fail) return json({ message: e.message }, e.status);
    console.error(e instanceof Error ? e.message : "unknown error"); // never log request bodies (password)
    return json({ message: "Something went wrong syncing COROS." }, 500);
  }
});
