# MAYA: a delivery workforce with a memory

**Short description:** A GitLab Duo workforce that repairs failed pipelines,
verifies the commit running on staging, and keeps reviewed company memory.

## The problem

Code generation is faster than the work needed to ship it. A failed test or broken
pipeline still needs someone to collect logs, understand contracts, make a source
change, follow CI, check deployment and preserve what the team learned.

## What MAYA does

MAYA connects to an existing repository and discovers its stack, workflows and
staging policy. An observer captures actual CI failures. A GitLab Duo orchestrator
delegates diagnosis, minimal source repair and independent scrutiny using frozen
logs/source and reviewed company lessons. MAYA validates the proposal and creates
a real repair MR. The exact repair commit must pass CI. An authorised staging merge
must then pass release CI, complete deployment and return the expected Git SHA
from the live endpoint before MAYA says the delivery is fixed.

The corrector proposes evidence-backed lessons. An operator reviews them before
reuse; incorrect versions can be retired without deleting their history. This is
scoped operational memory, not model retraining. The interactive dashboard makes
agents, original logs, complete source diffs, MRs, checks, deployment proof and
memory review inspectable.

## What is demonstrated

Two deliberately introduced pricing defects broke a real ecommerce GitLab pipeline.
Actual Duo sessions authored the source corrections. Real MRs and pipelines passed,
and GitLab Pages served the verified merge SHAs. The second investigation retrieved
the first reviewed lesson. Its automatic staging merge completed after the HTTP
request timed out: MAYA avoided duplicate writes, and read-only reconciliation
confirmed completion. A later controller change automates that reconciliation.

A separate Python/FastAPI GitHub workspace demonstrates different-stack discovery
and evidence isolation. A complete repair journey is proved for GitLab. Arbitrary
vendor integration, production healing and a full second-stack repair are not claimed.

## Implementation

TypeScript/Node.js, React, SQLite, GitLab Duo Agent Platform flow, GitLab/GitHub
provider adapters, encrypted credentials, hashed evidence, exact-source approval
gates and an installable CLI package. Free Render runs the console; GitLab Pages
runs ecommerce staging. Encrypted periodic GitLab checkpoints recover the demo's
operations records. Production would use a persistent database and stronger
multiuser access controls.

## Links

- Console: https://maya-yard-jassi.onrender.com
- Storefront: https://maya-demo-store-af3ce5.gitlab.io
- Store source and CI: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/43459489/maya-demo-store
- Required public GitLab source: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/43459489/showcase
- Detailed actual proof: [DELIVERY.md](DELIVERY.md)
- Video outline: [DEMO.md](DEMO.md)

This is draft copy for the team. The public YouTube video, team details, final
Devpost fields and actual submission have not been completed by creating this file.
