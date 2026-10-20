# MAYA

**Multi-Agent Yard for Automation.** A company-aware incident lab with evidence, explicit repair approval, independent checks, and reviewed operational memory.

V1 is a working **deterministic sandbox**, not a live LLM workforce. It supports isolated fixtures and two real, authenticated demo-service connectors. GitLab Duo source definitions and evidence handoffs are included; no live Duo execution is claimed. That integration remains necessary for a qualifying GitLab hackathon submission.

## Start locally

Requires Node.js 24+ (production containers use 24).

```sh
npm ci
npm run dev
# http://localhost:4200
```

Data defaults to `~/.maya/data/maya.sqlite`. Set `DATABASE_PATH` for another location. The default bind is loopback. A network-exposed instance requires `MAYA_ACCESS_TOKEN`; operators enter it on the login page. Tokens are server-side and excluded from agent evidence and exports. The UI session is an HttpOnly, SameSite cookie. Set `SECURE_COOKIE=true` behind HTTPS.

The parent workspace's `./start.sh` builds all three Docker services, creates a private `.env`, connects both companies, and uses durable named volumes. Company A runs on 4100, MAYA on 4200, Company B on 4300. Keep the `.env` private.

For a standalone checkout of this repository, run `./deploy/start.sh`. It pulls the three public GHCR images, generates separate private keys in `deploy/.env`, and starts the connected demo with persistent volumes. Requires Docker Compose and Python 3. Do not run this alongside the parent workspace launcher on the same ports. To stop it, run `docker compose -f deploy/compose.yaml down` from this repository. Use `MAYA_PORT`, `COMPANY_A_PORT`, and `COMPANY_B_PORT` to choose other local ports.

## A complete demo

1. Select Company A. Inject the booking capacity regression.
2. Watch evidence collection, scoped memory retrieval, diagnosis, a configuration proposal, and independent fixture checks.
3. Review the exact patch and digest, then approve. A live connector resets only the injected demo fault; real health/behavior probes must pass before the run is resolved.
4. Open Memory. Inspect the source run and separately approve its candidate lesson.
5. Inject the same incident again. A valid lesson is reused, and the investigation step is skipped.
6. Change Runtime context in Environment. This changes metadata, not the service's actual runtime. Repeat the incident: the old lesson is refused and a fresh diagnosis runs.
7. Switch to Company B. Inject the support priority inversion. The same engine uses a different connector to repair a Python service, with separate memory and evidence.
8. In an isolated simulation workspace, try an expired credential. The run escalates to its owner and never invents a secret.

The UI includes working company onboarding, run search, a workforce view, approvals, lesson review/retirement, context revision, connection probes, audit records, evidence exports, and a Duo handoff per run. Browser refresh and server restarts preserve SQLite records. Interrupted active work is marked interrupted, never silently resolved.

Repair authorization is saved before the network request. Each live fault has an instance ID, so replacing a fault with another of the same type invalidates the old approval. Failed or interrupted runs offer **Start fresh investigation** without injecting another fault. An approved repair with an uncertain result also offers **Recheck recovery (read-only)**: it probes the service without repeating the write or creating a repair lesson. Injection intents are journaled before external writes, and saved incidents without runs remain accessible after restart.

## What is actually connected

| Capability | V1 status |
| --- | --- |
| HTTP observation and authenticated demo configuration recovery | Working for Company A and Company B |
| Fixture contracts and live post-repair verification | Working |
| Scoped memory, review, versioning, expiry, stale-runtime rejection | Working |
| GitHub Actions CI, cross-stack browser checks, and commit-tagged GHCR delivery | Working; see Actions and delivery evidence |
| GitLab Duo supervisor/specialist flow | YAML bundle; registration/execution not verified |
| GitHub/GitLab merge requests, arbitrary CI repair, vendor monitoring | Not implemented |
| Continuous autonomous monitoring or production healing | Not implemented |

No fabricated performance reduction is displayed. Counts come from stored runs. The pool scenario uses an explicitly synthetic queuing model; it is not a production benchmark. Memory is stored playbooks, not model retraining.

## Verify and package

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm pack
```

The tarball provides a local CLI (`maya --help`, `maya --port 4200 --data /path/to/maya.sqlite`). It is **private/unpublished** on npm until a package name and release policy are selected. Use `npm exec --package ./maya-agent-sandbox-0.1.0.tgz -- maya --help` to try the bundle. Install the tarball into a local project or use the container for a hosted service; a package does not remove the backend and database.

## Live connector configuration

Set `COMPANY_A_URL`, `COMPANY_A_TOKEN`, `COMPANY_B_URL`, and `COMPANY_B_TOKEN` on the server. Only preconfigured demo URLs can be contacted; onboarding cannot inject arbitrary network destinations or shell commands. A connected company accepts only its supported incident. No agent sees connector tokens. A current fault must still match the captured scenario at recovery time.

If the database was first started without Company A's connector, its seeded workspace remains a simulation. Use a fresh deployment database or configure a new live workspace through the API; a connector is intentionally not silently rebound to an existing tenant.

## Cloud deployment

`render.yaml` defines three free web services and generates connector/access secrets through Render. No payment is required by this blueprint. Free services sleep when idle; warm them before a demo. Their filesystem is ephemeral: **SQLite may reset on restarts/redeploys**. For durable shared hosting, add persistent disks or a managed database after choosing a budget. The local Docker deployment already uses persistent volumes.

The operator key is `MAYA_ACCESS_TOKEN` in MAYA's Render Environment settings. A free deployment is suitable for synthetic demo data, not customer production use. Current deployment links and verification evidence belong in `docs/DELIVERY.md`.

## GitLab Duo

`.gitlab/duo/flows/incident-review.yml` defines a supervisor, investigator and verifier. Register it in **AI → Flows**, enable it for the provisioned project, and perform a real run against an exported handoff. Committing the YAML alone does not activate it. This initial flow is read-only and cannot approve or deploy. The local simulator is intentionally not relabeled as Duo.

Next platform gates: a successful runner session, credit/identity confirmation, scoped gateway authentication, and supported programmatic launch. Normal GitLab CI secrets must not be assumed available to Duo jobs. See `docs/ARCHITECTURE.md`.

## Security scope

One local/demo operator is the trust boundary. Company IDs scope all records; this is not a finished enterprise multiuser authorization system. No arbitrary user code is executed. Repairs are deterministic configuration changes on explicitly connected fictional demo services. Use synthetic data, HTTPS and an operator key on public deployments. Audit exports may include any text an operator enters. No production credentials belong in onboarding, prompts, or exports.

MIT licensed.
