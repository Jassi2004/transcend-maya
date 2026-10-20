# Synthetic demo evidence

These handoffs were downloaded through the authenticated hosted MAYA API after the final cloud recovery-to-Duo browser journeys on 20 October 2026. Company A run: `827e093a-dbed-496b-85c9-5de839a14892`; Company B run: `81295924-5083-4e1b-a5f1-9394d417f47e`. The producing Render build was `b46f057a9fd33064950a77d2305e4e593e202fe8`, verified through `/api/health`.

The records contain fictional demo incidents, fault-instance IDs, exact-artifact authorization, fixture checks and separate pre/post-repair HTTP observations. Approvals were performed by an automated test, not a named human. They are point-in-time records, not present health checks.

The handoff's `provider=deterministic` and `duoExecutionVerified=false` describe the recovery at export time. The later real Duo reviews are recorded separately in `../evidence/cloud-company-a-duo-review.json` and `../evidence/cloud-company-b-duo-review.json`. Their own frozen snapshots are hashed; a later handoff download does not overwrite what was shared.

The earliest Duo reviews used older versions of these files at GitLab commit `cbbc542e757137b708a785f51db9ed03d558889f`. See `../evidence/duo-reviews.json` for those historical session results. They do not describe the refreshed files.
