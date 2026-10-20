# MAYA V2 delivery proof

MAYA's primary product is now actual CI/CD source repair through GitLab Duo. The first workload is a simple ecommerce app, Field Supply. The earlier bounded fault-reset experiment is retained at `/?lab=1` and documented in [legacy delivery](LEGACY-DELIVERY.md).

- [MAYA console](https://maya-yard-jassi.onrender.com)
- [Ecommerce source + CI history](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/43459489/maya-demo-store)
- [Live staging storefront](https://maya-demo-store-af3ce5.gitlab.io)
- [Independent deployed revision](https://maya-demo-store-af3ce5.gitlab.io/version.json)
- [Delivery workforce definition](../.gitlab/duo/flows/delivery-workforce.yml)

## First actual repair

The deliberate source regression changed an inclusive shipping boundary to `subtotalCents > 5000`. The real unit-tests job failed on exactly-$50 shipping and cart pricing. Duo received actual failed-job traces and source snapshots, diagnosed the boundary and returned a complete replacement of `lib/pricing.js`. Its initial unrelated pricing-policy question was clarified as preserving existing pre-discount shipping behaviour before a fresh proposal.

- Failed source commit: `3c7a0903ab0ae63fa527eb7e1c620d04fff3fa07`
- [Initial Duo diagnosis 9744997](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/43459489/showcase/-/automate/agent-sessions/9744997)
- [Completed repair workforce 9745458](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/43459489/showcase/-/automate/agent-sessions/9745458)
- [Actual repair MR !1](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/43459489/maya-demo-store/-/merge_requests/1)
- Repair commit: `2e9c3baa1d1c9a1c481b58451c32f778d4d8459c`
- Staging merge commit: `45a696d7f527acf8b8abe434d96f63cda3e8e53f`

The actual MR changes one comparison from `> 5000` to `>= 5000`. Tests and pipeline files are unchanged. Its unit tests, syntax checks, dependency audit and package job passed before the separately authorised staging merge. The release pipeline 2967383733 passed all six jobs and the live version endpoint returned the exact merged SHA with HTTP 200. Corrector session 9746395 produced lesson version 2, reviewed and activated after checking original logs, tests and merge provenance. The earlier incomplete candidate is retired and retained in history. The first verifier delegation lacked artifacts; its output is not independent validation. Actual CI provides execution evidence, and flow 1.0.1 explicitly forwards complete artifacts to subsequent verifier delegations. See [machine-readable proof](evidence/delivery-v2-first-repair.json).

## Reproduce

Run MAYA with a configured Duo flow and access to a demo repository. Connect its URL, inspect discovered CI and policy, explicitly allow evidence sharing, then introduce a real source defect on the demo default branch. Observe the failed pipeline. Investigate, inspect actual source diff and evidence, approve publication, wait for exact-commit CI, authorise staging merge and verify the live revision. Propose and review learning separately. For supervised staging, enable its explicit policy consent before introducing a later failure.

The UI and controller tests use fake providers for deterministic validation. They are not evidence of actual Duo execution. Real session, pipeline, MR and deployment records above are independently inspectable. A deliberate source regression is a demo stimulus; its correction is authored by Duo from real logs/source, not a preselected repair recipe.

## Hackathon fit

Official rules were reread in Brave on 20 October. Path A permits a new app, CI/CD and automation; GitLab Duo Agent Platform is required. Its supervised example explicitly includes failing-pipeline repair and staging deployment, followed by production approval. Public MIT GitLab source, visible pipeline history, English project description and a public YouTube demo under three minutes remain submission requirements. Building/deploying MAYA is not a submitted Devpost entry or a guarantee of an award.
