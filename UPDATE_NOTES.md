# What changed

- **No database changes.** Everything new is stored in the existing `user_data` table (keys: `onb`, `home`, `addict`, `conn`). No new Supabase functions to deploy.
- `index.html`: all app changes. `sw.js`: cache version bumped so the update reaches installed copies.
- Cloudflare: just redeploy the static files as before.

## Garmin / Apple Health
Apple gives websites no access to HealthKit, and Garmin has no free public API (their official one needs a business application).
So the app imports exports instead: Garmin `.fit` / `.zip` / `.csv` / `.tcx` / `.gpx`, and Apple Health `export.zip`. Parsing runs in the browser; nothing is uploaded.
For true background sync you would need either Garmin's approved Health API keys, or a native iOS wrapper (e.g. Capacitor + HealthKit).
