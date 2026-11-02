// Food scan: meal photo / nutrition label / text description -> itemised calories + macros.
// 100% free stack, no billing anywhere:
//   - Google Gemini API FREE tier (key from aistudio.google.com/apikey, project must NOT have billing attached)
//   - USDA FoodData Central (free key from fdc.nal.usda.gov/api-key-signup)
// Accuracy design:
//   1. The vision model identifies each food and estimates its weight in grams.
//   2. Nutrition numbers come from the USDA database (matched in code), not from the model's memory.
//   3. Nutrition labels are read directly and the printed numbers are used as-is.
// Deploy: supabase functions deploy food-scan --no-verify-jwt
// Secrets: GEMINI_API_KEY (required), FDC_API_KEY (recommended), GEMINI_MODEL (optional), FOOD_DAILY_CAP (optional, default 20)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Tried in order; the first one the API recognises is used. Set GEMINI_MODEL to pin a free-tier model from AI Studio.
const MODELS = Deno.env.get("GEMINI_MODEL")
  ? [Deno.env.get("GEMINI_MODEL")!]
  : ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
const DAILY_CAP = Number(Deno.env.get("FOOD_DAILY_CAP") ?? 20); // per user; the free Gemini quota is shared by everyone
const FDC_KEY = Deno.env.get("FDC_API_KEY") ?? "DEMO_KEY";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
class Fail extends Error { constructor(public status: number, msg: string) { super(msg); } }
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown) => (Number.isFinite(+(v as number)) ? +(v as number) : 0);
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

// ---------- Gemini (free tier) with JSON output
async function gemini(system: string, parts: unknown[]): Promise<any> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Fail(503, "Food scan isn’t set up yet (missing GEMINI_API_KEY).");
  for (const model of MODELS) {
    let res: Response;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 4096 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch { throw new Fail(502, "Couldn’t reach the AI service. Try again."); }
    if (res.status === 404) continue; // model name not available, try the next one
    if (res.status === 429) throw new Fail(429, "The free AI limit has been reached for now. Try again later, or add foods by search or barcode.");
    if (!res.ok) {
      const t = (await res.text()).slice(0, 300);
      console.error("gemini", model, res.status, t);
      if (/API key|PERMISSION|API_KEY/i.test(t) || res.status === 403) throw new Fail(503, "The Gemini API key isn’t valid. Check the GEMINI_API_KEY secret.");
      throw new Fail(502, "The AI service returned an error. Try again.");
    }
    const d = await res.json();
    if (d.promptFeedback?.blockReason) throw new Fail(422, "That image couldn’t be analyzed. Try a different photo.");
    const text = (d.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("")
      .replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
    try { return JSON.parse(text); } catch { throw new Fail(502, "The AI gave an unreadable answer. Try again."); }
  }
  throw new Fail(503, "No Gemini model was available. Set the GEMINI_MODEL secret to a free-tier model listed in AI Studio.");
}
const imgParts = (imgs: string[]) => imgs.map((data) => ({ inlineData: { mimeType: "image/jpeg", data } }));

// ---------- prompts
const MEAL_SYSTEM = `You are a registered dietitian who is an expert at identifying foods and judging portion weights from photos and descriptions.
Identify every food and drink and estimate the weight actually eaten. Nutrition values are looked up in a database afterwards, so focus on WHAT it is and HOW MUCH.

Portion method (the main source of error, be careful):
- Find scale references: dinner plate ~26 cm, salad plate ~20 cm, fork ~19 cm, tablespoon, hand, can (355 ml), cup, packaging.
- Estimate each food's volume or count, then convert to grams with realistic densities. Use COOKED weights for cooked food.
- Several photos are different views of the SAME meal. Never count a food twice.
- Include likely hidden calories as separate items: cooking oil/butter, dressings, sauces, cheese, sugar/cream in drinks, with your assumption.
- Do not undercount restaurant and takeaway food; it is usually larger and oilier than home cooking.
- Standard mixed dishes (pizza slice, burrito, sandwich, curry): one item for the dish is fine.
- Ignore non-food. If nothing edible is visible or described, return an empty items list.
- If the person gives context or amounts, trust it over your visual guess.

Return ONLY JSON of this exact shape:
{"meal_name":"short name","items":[{"name":"plain name shown to the person","usda_query":"short USDA-style search phrase incl. preparation, e.g. chicken breast roasted / rice white cooked / egg whole fried / olive oil","grams":number (g, or ml for drinks, actually eaten),"confidence":number 0-1 (identity AND portion),"assumption":"short note e.g. about 1 cup cooked, cooked in 1 tbsp oil","per100":{"kcal":number,"protein":number,"carbs":number,"fat":number}}],"question":"one short question ONLY if an unknown changes total calories by 15% or more, else empty string"}
per100 is your own estimate per 100 g, used as a sanity check.`;

const LABEL_SYSTEM = `You read Nutrition Facts panels (US, EU, UK and others) with perfect transcription accuracy.
Copy the PRINTED numbers; never estimate or correct them. Report PER SERVING values when a per-serving column exists.
If only a per-100 g / per-100 ml column exists, report per 100 and set serving_grams to 100.
serving_grams is the serving size in grams (or ml) as printed, e.g. "2/3 cup (55g)" -> 55.
If a value is not visible use 0 and lower "legibility". If the image is not a nutrition label, legibility is 0.
Return ONLY JSON: {"product":"name","serving_grams":number,"serving_text":"as printed","servings_per_container":number,"basis":"per_serving" or "per_100","kcal":number,"protein":number,"carbs":number,"fat":number,"legibility":number 0-1}`;

// ---------- USDA FoodData Central
type Cand = { desc: string; type: string; k: number; p: number; c: number; f: number };
async function usda(query: string): Promise<Cand[]> {
  try {
    const u = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
    u.searchParams.set("api_key", FDC_KEY);
    u.searchParams.set("query", query);
    u.searchParams.set("dataType", "Foundation,SR Legacy,Survey (FNDDS)");
    u.searchParams.set("pageSize", "10");
    const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const d = await res.json();
    const out: Cand[] = [];
    for (const f of d.foods ?? []) {
      const n = (code: string) => (f.foodNutrients ?? []).find((x: any) => String(x.nutrientNumber) === code)?.value;
      const p = num(n("203")), fat = num(n("204")), c = num(n("205"));
      let k = n("208") ?? n("957") ?? n("958");
      k = k != null ? num(k) : 4 * p + 4 * c + 9 * fat;
      if (!k && !p && !c && !fat) continue;
      out.push({ desc: String(f.description ?? ""), type: String(f.dataType ?? ""), k, p, c, f: fat });
    }
    return out;
  } catch { return []; }
}

// Pick the best USDA entry in code (no extra AI call, so free-tier quota is spent once per scan).
const STOP = new Set(["of", "and", "with", "in", "the", "a", "an", "or", "raw", "plain"]);
const toks = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => w.replace(/(es|s)$/, ""));
const COOK = ["cooked", "roasted", "grilled", "fried", "boiled", "baked", "steamed", "broiled", "scrambled", "toasted", "stewed"];
function bestMatch(query: string, cands: Cand[], modelK: number): Cand | null {
  const q = toks(query);
  if (!q.length || !cands.length) return null;
  const qs = query.toLowerCase();
  const wantsRaw = /\braw\b/.test(qs), wantsCooked = COOK.some((w) => qs.includes(w));
  const scored = cands.map((c, i) => {
    const d = toks(c.desc), ds = new Set(d), dl = c.desc.toLowerCase();
    let s = q.filter((w) => ds.has(w)).length / q.length;
    s -= Math.min(0.25, Math.max(0, d.length - q.length) * 0.02); // prefer specific-but-not-bloated names
    s -= i * 0.02;                                               // USDA relevance order
    if (c.type === "Foundation" || c.type === "SR Legacy") s += 0.05;
    const isRaw = /\braw\b/.test(dl), isCooked = COOK.some((w) => dl.includes(w));
    if (wantsCooked && isRaw) s -= 0.35;
    if (wantsRaw && isCooked) s -= 0.35;
    if (!wantsRaw && !wantsCooked && isRaw && !/(fruit|vegetable|lettuce|tomato|cucumber|apple|banana|berry|salad|spinach|carrot|onion|pepper)/.test(qs)) s -= 0.1;
    return { c, s };
  }).sort((a, b) => b.s - a.s);
  if (scored[0].s < 0.55) return null;
  // Among near-ties, take the entry closest to the model's own calorie estimate (guards against a wrong variant).
  const near = scored.filter((x) => x.s >= scored[0].s - 0.15);
  if (modelK > 0 && near.length > 1) near.sort((a, b) => Math.abs(a.c.k - modelK) - Math.abs(b.c.k - modelK));
  return near[0].c;
}

// ---------- pipeline
async function analyzeMeal(note: string, images: string[], fix: string, prev: any[]) {
  let text = images.length ? `Analyze this meal (${images.length} photo${images.length > 1 ? "s" : ""} of the same meal).` : "Analyze this meal description.";
  if (note) text += `\nContext from the person: ${note}`;
  if (fix && prev.length) text += `\nPrevious estimate: ${JSON.stringify(prev)}\nCorrection from the person: ${fix}\nReturn the FULL corrected list. Keep items the correction does not touch at the same weight.`;
  const r = await gemini(MEAL_SYSTEM, [...imgParts(images), { text }]);
  const items = (Array.isArray(r.items) ? r.items : []).filter((i: any) => i && i.name && num(i.grams) > 0).slice(0, 20);
  if (!items.length) return { name: "", items: [], q: "" };

  const cands = await Promise.all(items.map((i: any) => usda(String(i.usda_query || i.name))));
  const out = items.map((i: any, x: number) => {
    const g = clamp(Math.round(num(i.grams)), 3, 2000), q = g / 100, fb = i.per100 ?? {};
    let conf = clamp(num(i.confidence) || 0.6, 0.05, 1);
    const m = bestMatch(String(i.usda_query || i.name), cands[x] ?? [], num(fb.kcal));
    const assume = String(i.assumption ?? "");
    if (m) {
      const fk = num(fb.kcal);
      if (fk > 0 && (m.k > fk * 2 || m.k < fk / 2) && Math.abs(m.k - fk) > 40) conf *= 0.7; // database and AI disagree a lot
      return { n: String(i.name), g, k: r1(m.k * q), p: r1(m.p * q), c: r1(m.c * q), f: r1(m.f * q), conf: r1(conf),
        note: [assume, `USDA: ${m.desc}`].filter(Boolean).join(" · "), src: "usda" };
    }
    return { n: String(i.name), g, k: r1(num(fb.kcal) * q), p: r1(num(fb.protein) * q), c: r1(num(fb.carbs) * q), f: r1(num(fb.fat) * q),
      conf: r1(conf * 0.75), note: [assume, "AI estimate (no database match)"].filter(Boolean).join(" · "), src: "ai" };
  });
  return { name: String(r.meal_name || "Meal"), items: out, q: String(r.question ?? "") };
}

async function readLabel(note: string, images: string[]) {
  const r = await gemini(LABEL_SYSTEM, [...imgParts(images), { text: "Read this nutrition label." + (note ? `\nContext: ${note}` : "") }]);
  const leg = clamp(num(r.legibility), 0, 1);
  const k = num(r.kcal), p = num(r.protein), c = num(r.carbs), f = num(r.fat);
  if (leg < 0.25 || (!k && !p && !c && !f)) return { name: "", items: [], q: "" };
  const g = clamp(Math.round(num(r.serving_grams)) || 100, 1, 2000);
  const atw = 4 * p + 4 * c + 9 * f;
  const consistent = atw > 0 && Math.abs(k - atw) / Math.max(k, atw) < 0.25;
  const notes = [
    r.basis === "per_100" ? "Label only lists per 100 g, adjust the amount" : (r.serving_text ? `Serving: ${r.serving_text}` : ""),
    num(r.servings_per_container) > 0 ? `${r.servings_per_container} servings per container` : "",
    consistent ? "Read from the label" : "Numbers don’t add up, double-check them against the package",
  ].filter(Boolean).join(" · ");
  const name = String(r.product || "Packaged food");
  return { name, items: [{ n: name, g, k, p, c, f, conf: r1(consistent ? Math.min(0.98, 0.6 + 0.38 * leg) : 0.5 * Math.max(leg, 0.5)), note: notes, src: "label" }], q: "" };
}

// ---------- per-user daily cap (protects the shared free quota)
async function checkCap(uid: string) {
  const day = new Date().toISOString().slice(0, 10);
  const { data } = await admin.from("food_scan_usage").select("n").eq("user_id", uid).eq("day", day).maybeSingle();
  const n = (data?.n ?? 0) + 1;
  if (n > DAILY_CAP) throw new Fail(429, `Daily scan limit reached (${DAILY_CAP}). Search or type foods instead, or try again tomorrow.`);
  await admin.from("food_scan_usage").upsert({ user_id: uid, day, n }, { onConflict: "user_id,day" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method !== "POST") throw new Fail(405, "POST only.");
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u?.user) throw new Fail(401, "Please sign in again.");
    const b = await req.json().catch(() => ({}));
    const mode = ["meal", "label", "text"].includes(b.mode) ? b.mode : "meal";
    const note = String(b.note ?? "").slice(0, 600);
    const images: string[] = (Array.isArray(b.images) ? b.images : []).slice(0, 3).map((s: unknown) => String(s).replace(/^data:image\/\w+;base64,/, ""));
    if (images.some((s) => s.length > 5_000_000)) throw new Fail(413, "That photo is too large. Try a smaller one.");
    if (mode !== "text" && !images.length) throw new Fail(400, "Add a photo first.");
    if (mode === "text" && note.trim().length < 3) throw new Fail(400, "Describe what you ate.");
    await checkCap(u.user.id);
    const prev = Array.isArray(b.prev) ? b.prev.slice(0, 20) : [];
    const result = mode === "label" ? await readLabel(note, images) : await analyzeMeal(note, mode === "text" ? [] : images, String(b.fix ?? "").slice(0, 400), prev);
    return json(result);
  } catch (e) {
    if (e instanceof Fail) return json({ message: e.message }, e.status);
    console.error(e instanceof Error ? e.message : "unknown"); // never log images or request bodies
    return json({ message: "Something went wrong analyzing that. Try again." }, 500);
  }
});
