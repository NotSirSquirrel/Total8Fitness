"""Pulls your COROS activities (unofficial Training Hub API), encrypts them with your
passphrase, and writes data/workouts.enc. The repo only ever contains ciphertext.
Needs: pip install cryptography"""
import os, json, base64, hashlib, urllib.request, urllib.parse, urllib.error
from datetime import datetime, timezone, timedelta
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

OUT = "data/workouts.enc"
PASS = os.environ["DATA_PASSPHRASE"]
ITER = 600000
BASES = {"en": "https://teamapi.coros.com", "eu": "https://teameuapi.coros.com", "cn": "https://teamcnapi.coros.com"}
BASE = os.environ.get("COROS_BASE_URL") or BASES.get(os.environ.get("COROS_REGION", "en"), BASES["en"])


class ApiErr(Exception):
    pass


def key_for(salt):
    return hashlib.pbkdf2_hmac("sha256", PASS.encode(), salt, ITER, 32)


def load():
    if not os.path.exists(OUT):
        return None, {"acts": {}}
    f = json.load(open(OUT))
    salt = base64.b64decode(f["salt"])
    try:
        pt = AESGCM(key_for(salt)).decrypt(base64.b64decode(f["iv"]), base64.b64decode(f["ct"]), None)
    except Exception:
        raise SystemExit("Could not decrypt data/workouts.enc. Did DATA_PASSPHRASE change? Delete the file to start over.")
    return salt, json.loads(pt)


def save(salt, data):
    salt = salt or os.urandom(16)  # salt is reused so a remembered key keeps working
    iv = os.urandom(12)
    ct = AESGCM(key_for(salt)).encrypt(iv, json.dumps(data, separators=(",", ":")).encode(), None)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    e = lambda b: base64.b64encode(b).decode()
    json.dump({"v": 1, "salt": e(salt), "iv": e(iv), "ct": e(ct)}, open(OUT, "w"))


def call(path, token=None, body=None, params=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "Mozilla/5.0")
    if token:
        req.add_header("accesstoken", token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"COROS returned HTTP {e.code} for {path} (rate limit or blocked?)")
    if out.get("result") != "0000":
        raise ApiErr(f"{path}: {out.get('message')} (result {out.get('result')})")
    return out


def login():
    out = call("/account/login", body={"account": os.environ["COROS_EMAIL"], "accountType": 2,
                                       "pwd": hashlib.md5(os.environ["COROS_PASSWORD"].encode()).hexdigest()})
    return out["data"]["accessToken"]


def fetch(token, start_day):
    items, page = [], 1
    while True:
        p = {"size": 200, "pageNumber": page, "modeList": ""}
        if start_day:
            p["startDay"] = start_day
            p["endDay"] = (datetime.now() + timedelta(days=1)).strftime("%Y%m%d")
        d = call("/activity/query", token, params=p)["data"]
        items += d.get("dataList") or []
        if page >= int(d.get("totalPage") or 1):
            return items
        page += 1


def kind(sport, name):
    s, n = int(sport or 0), (name or "").lower()
    if s in (104, 105) or "hike" in n:
        return "Hike"
    if 100 <= s < 200:
        return "Run"
    if 200 <= s < 300:
        return "Cycle"
    if 300 <= s < 400:
        return "Swim"
    if s == 402 or "strength" in n:
        return "Strength"
    if s == 900 or "walk" in n:
        return "Walk"
    return "Other"


def conv(a):
    d = str(a.get("date") or "")
    d = f"{d[:4]}-{d[4:6]}-{d[6:]}" if len(d) == 8 else datetime.fromtimestamp(a["startTime"], timezone.utc).strftime("%Y-%m-%d")
    return {"sid": str(a["labelId"]), "d": d, "t": kind(a.get("sportType"), a.get("name")),
            "n": a.get("name") or "Workout", "m": a.get("distance") or 0,
            "s": a.get("workoutTime") or a.get("totalTime") or 0,
            "k": round((a.get("calorie") or 0) / 1000),  # COROS reports calories x1000
            "h": a.get("avgHr") or 0, "el": a.get("ascent") or 0, "w": a.get("avgPower") or 0,
            "et": a.get("totalTime") or 0, "dv": a.get("device") or "", "st": a.get("sportType")}


def main():
    salt, store = load()
    dump = lambda s: json.dumps({k: v for k, v in s.items() if k != "updated"}, sort_keys=True)
    before = dump(store)
    last = store.get("last")
    sd = (datetime.strptime(str(last), "%Y%m%d") - timedelta(days=7)).strftime("%Y%m%d") if last else None
    token, items = store.get("ctoken"), None
    if token:
        try:
            items = fetch(token, sd)
        except ApiErr:
            items = None  # token expired, log in again
    if items is None:
        try:
            token = login()
            items = fetch(token, sd)
        except ApiErr as e:
            raise SystemExit(f"COROS error: {e}. Check COROS_EMAIL / COROS_PASSWORD (email + password login, not Google/Apple).")
    acts = store.get("acts", {})
    newest = int(last or 0)
    for a in items:
        acts[str(a["labelId"])] = conv(a)
        newest = max(newest, int(a.get("date") or 0))
    print(f"{len(items)} fetched, {len(acts)} total")
    store.update({"acts": acts, "last": newest, "ctoken": token})
    if dump(store) == before:
        print("No changes")
        return
    store["updated"] = datetime.now(timezone.utc).isoformat()
    save(salt, store)
    print("Saved", OUT)


main()
