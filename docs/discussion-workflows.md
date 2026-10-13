# Durable discussion workflows

Deploy this backend and migration `20261013100000_discussion_workflows` before the paired DocGr-fr change. No new environment variables or dependencies are needed.

The existing discussion, Astra grant, operation ledger, owner decision endpoint and ProjectContextService remain authoritative. The new table stores orchestration metadata, not another ACL or document mutation system.

API under `/api/docgrid/repositories/:projectId/discussions/:id`:

- `GET /workflows`: latest 30 plans with immutable steps, statuses and events; reconciles approvals and interrupted requests.
- `POST /workflows`: `{requestKey,goal,model?,folder?,sourceIds?}`. Calls the existing model endpoint in advisor/chat mode, validates a bounded JSON plan from `answer`, then creates the existing metadata-only `docgrid_plan_document` operation.
- `GET /capabilities`: actual live grant tools.
- `POST /workflows/:workflowId/run`: `{requestKey}`. Claims only the next eligible step and calls the existing DiscussionService. Replays never advance another step.
- `POST /workflows/:workflowId/cancel`: `{requestKey}`. Claims cancellation and delegates pending decisions to Astra.

Only existing human approval endpoints approve a plan or document proposal. Full step instructions, tool types, selected source IDs, model and goal are bound to the approved operation. A workflow plan cannot authorize `docgrid_submit_document`, including through a custom grant which otherwise allows that tool. Built-in grants receive only the planning capability, never submission.

Each plan freezes a source inventory (up to 500 documents, 8 steps). A sorting step processes up to 20 of those IDs per batch and continues after the proposal decision. Moves do not alter later batches. Selecting a different folder or model requires a new plan. Each actual turn records exact versioned sources, coverage, retrieval, provider data and an operation ID. The project summary and conversation context are limited to the request's source environment. Ordinary chat can discuss previous workflow results when their source scope is contained in the current selection. Full-project chat retains legacy history. Old turns without recorded scope remain visible but are not silently included in narrowed model context.

Execution is explicit: the user starts each next step/batch. No autonomous background worker or terminal/web tools are implied. Failures are durable and retries are explicit. A ten-minute expired execution lease fails closed; a completed turn is reconciled with its pending proposal rather than automatically applying it. Interrupted planning can be cancelled and regenerated. API idempotency, transaction claims and the existing turn uniqueness constraint prevent duplicate execution. Audit events are only appended for state transitions, not polls.

Validation:

- `npm run test:workflows`: isolated embedded PostgreSQL, real Nest HTTP routes, SQL and Astra permissions/approvals; synthetic model only.
- `node scripts/standalone-http-test.cjs --embedded --discussions-only` after build: existing discussion regressions.
- `node scripts/astra-docgrid-test.cjs`: existing operation workflow regressions.

Neither migration nor tests contact production or a paid model.
