# COROS sync setup (one time)

1. Supabase SQL Editor: run the new `coros_links` section at the bottom of `supabase_setup.sql`.
2. Deploy the function (Supabase CLI, from this folder):
   `supabase link --project-ref jmghhiakyyyncnlmrwtg`
   `supabase functions deploy coros-sync`
   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to functions automatically.)
3. Publish the updated `index.html`.

Each user then opens Workouts → Connect COROS and enters their own COROS login.
The old GitHub Action and `scripts/sync_coros.py` were removed; the function replaces them.
