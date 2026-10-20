# Synthetic demo evidence

The Company A/B JSON files were downloaded through the authenticated hosted MAYA handoff API after the cross-stack browser recovery journey on 20 October 2026 (runs `6477d671-675f-480e-b82a-1c3ce4026170` and `a74bc5de-335b-475a-8e01-bee4b61e22ef`). They contain fictional demo incidents, fault-instance IDs, exact-artifact authorization and recorded HTTP results. They are point-in-time records, not present health checks. Fixture assertions and actual HTTP probes are labeled separately. Approval in these examples was performed by the browser test.

The files were captured before the review-bridge release; the newer separate `liveBefore`/`liveAfter` fields are not expected in these exports. No source revision was exposed by that hosted build, so an exact producing SHA is not attested.

The first real Duo reviews used **earlier versions** of these examples at GitLab commit `cbbc542e757137b708a785f51db9ed03d558889f`. See `../evidence/duo-reviews.json` for the session records and original commit. Those reports do not describe these refreshed files or prove that Duo ran during the original incident recovery.
