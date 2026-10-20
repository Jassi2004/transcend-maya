# A company running on MAYA

MAYA is a separate delivery service. Your application keeps its own repository,
tests, CI and hosting. GitLab Duo supplies the reasoning workforce. MAYA connects
the evidence and enforces the delivery policy.

## What onboarding actually connects

1. Connect a GitLab.com or GitHub repository URL. MAYA reads its current source,
   stack, CI configuration and environment variable names. A URL alone does not
   grant access to private infrastructure or import secrets.
2. Supply a repository-scoped credential. GitHub needs Actions read, Contents and
   Pull requests write, Commit statuses read and Deployments read for the complete
   demonstrated workflow. Provider permissions are verified by the operations
   that use them; a stored token alone is not proof of access.
3. Enable evidence sharing with the configured GitLab Duo project. Enable
   automatic investigation to launch the workforce for new failures.
4. Declare the staging boundary in `.maya.yml`, rediscover configuration and
   enable supervised staging. High-confidence changes to existing application
   source can proceed automatically. Changes to tests, CI, package scripts or the
   deployment policy require operator review. A changed policy revokes supervised
   mode until it is reviewed again.
5. Connect deployment proof: a provider deployment record and a public HTTPS JSON
   endpoint returning `commit`, `buildCommit` or `sha` equal to the full deployed
   Git SHA. HTTP 200 without the expected SHA is insufficient.

## The demonstrated GitHub company

Signal Desk is an independent Python/FastAPI service using GitHub Actions and
Render. Its default branch is explicitly **staging**, not production. The health
endpoint reports Render's actual `RENDER_GIT_COMMIT` value.

Its verification workflow runs lint, formatting and tests, then builds the
container image. Render deploys after CI passes. A separate workflow runs after
that workflow succeeds and records a GitHub staging deployment. It marks success
only when the live endpoint returns the exact release SHA and critical-priority
routing works. A newer source revision supersedes an older verification; neither
a deployment record nor a successful build is treated as proof on its own.

## What happens during a failure

The current automatic observer handles failed pipelines at the **current default
branch head**. An unmerged feature PR is not automatically repaired in this
version. Keep required PR checks enabled to stop a known failing PR reaching the
staging branch.

For a failed staging push, MAYA preserves the signal, original job logs and source
at an immutable commit. Duo's orchestrator, investigator, specialist and verifier
reason from that evidence. MAYA validates the returned file replacements against
the observed source and records the proposal digest. Under the explicit supervised
policy it opens a repair PR, waits for checks on the exact repair SHA and merges
only if the original source and policy are still current.

The record stays open until release CI passes, the provider reports successful
staging deployment and the live endpoint serves the exact merged SHA. A failed
repair has a bounded correction budget. Missing access, protected-file edits,
uncertain writes and exhausted attempts stop for input; they do not authorize
invented credentials or blind retries.

If a Duo launch is unconfirmed, **Find existing Duo session** searches by the
frozen evidence digest. A matching session can be recovered without another
launch. An empty search requires provider inspection and a recorded recovery
decision before another investigation can be requested. MAYA retains both the
original attempt and the decision.

After verified recovery, the corrector proposes a scoped operational lesson. An
operator reviews it before activation. Future matching incidents retrieve that
reviewed context alongside fresh evidence. This is advisory memory retrieval,
not model training or blanket permission to repeat an old patch.

## Where to inspect the work

- **Delivery:** incident categories, the clickable workforce map, source diff,
  original failure, exact-commit CI, staging proof and the recorded timeline.
- **Evidence library:** captured source, logs, proposals, approvals and release
  receipts, with immutable commit identities and content hashes.
- **Company memory:** candidate, active and retired lessons with provenance and
  review history.
- **Connections & policy:** source discovery, active consent, staging boundary,
  credential availability, revision endpoint and checkpoint health.

External tools such as Datadog, Jenkins or incident.io need their own credentials
or authenticated signals. They are not connected by pasting a repository URL.
Production rollout and arbitrary company-wide self-healing are outside this
demonstrated staging workflow.
