# MAYA: pushed code to verified staging deployment

**Priority correction, 20 October:** MAYA is a CI/CD fixer first. Build and prove one
real GitLab delivery loop around one simple ecommerce application before adding
general incident-management surfaces or vendor integrations. The earlier bounded
fault-reset lab does not demonstrate this core requirement.

Developer push → real pipeline failure → observer reads job logs and source → Duo
orchestrator/specialists propose actual source repair → branch/MR → actual CI →
bounded correction loop if still failing → authorised merge/staging deployment →
exact deployed-revision and health verification → reviewed lesson. Incidents are
context for this process. The UI starts with the delivery journey and an inspectable
workforce map; it is not a ticketing application.

Primary acceptance: a real GitLab pipeline fails due to a source defect, a real Duo
workforce proposes the correction, MAYA creates a real MR, tests pass, authorised
merge produces a real staging deployment, and a live version probe matches the
deployed commit. Repeat with a related defect and demonstrate scoped memory being
used as evidence-backed guidance. Never hard-code the repair from the demo seed.

Support GitHub URL discovery, but use GitLab CI/CD for the first complete hackathon
journey. Modes: assisted (operator gates) and explicitly authorised supervised
staging (bounded repair/MR/test/merge loop). Production remains an explicit gate.

User request: replace the bounded lab as the main product with real repository onboarding,
continuous observation, GitLab Duo investigation and repair proposals, approved GitHub
pull requests, actual CI verification, reviewed memory, and a clickable operations map.
Keep the existing lab available explicitly as a lab. Never represent fixtures as AI work.

## Acceptance journey

1. Paste a GitHub repository URL. Discover source, stack, workflows, environment variable
   names and integrations from immutable repository files. Show missing authorization.
2. Persist and continuously observe workflow failures and explicitly configured services.
   Also accept authenticated, deduplicated webhook signals and operator reports.
3. Classify incident, gather scoped source/log evidence and retrieve reviewed lessons.
4. Launch a real GitLab Duo supervisor/specialist flow. Retain session identity,
   evidence digest, component messages and validated structured proposals.
5. Inspect exact proposed files and approve a digest tied to the repository base SHA.
   Create an actual branch and PR, never mutate a default branch directly.
6. Observe GitHub checks for the exact PR commit. Merge only after explicit approval,
   current base validation and required green checks. Observe deployment separately.
7. Propose and review company-scoped lessons with verified source provenance.
8. Explain every step through a clickable map, incident timeline, evidence browser,
   proposal diff, integration settings, and actionable missing-access states.

## Guardrails

Repository access does not grant access to private infrastructure. Use scoped encrypted
credentials, distinguish discovery from connectivity, redact secrets, never execute
repository commands on MAYA's host, journal remote writes, and never auto-repeat
ambiguous writes. Tests with fake transports are not evidence of real AI execution.
Cloud SQLite persistence must be described and export/restore supported.

## Delivery tracking

- [x] Repository discovery and real integration clients
- [x] Scoped records, evidence, encrypted credentials, import/export
- [x] Continuous observers and authenticated webhook ingress
- [x] Real Duo workforce and structured source repair plans
- [x] Digest-bound PR creation, exact-commit CI, explicit merge
- [x] Reviewed operational memory and correction history
- [x] New operations UI and interactive diagram
- [x] Backend/security/browser regression tests
- [x] Real GitLab ecommerce repair and second-stack GitHub discovery
- [ ] Second failure using reviewed memory and supervised staging
- [ ] Hosted V2 deployment and restoration verification
