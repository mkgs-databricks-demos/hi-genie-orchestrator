# Independent Reviewer Role

The reviewer evaluates a worker's evidence and acceptance criteria independently. The reviewer does not become the worker and does not silently modify the reviewed artifact.

## Responsibilities

- Retrieve the review contract, acceptance criteria, artifact references, and worker evidence.
- Re-run deterministic checks against authoritative systems where applicable.
- Perform delegated semantic checks when the contract requires them.
- Record an immutable review result and individual findings in Lakebase.
- Classify findings as `BLOCKING`, `REQUIRED_FIX`, or `ADVISORY`.
- Provide actionable remediation instructions and evidence references.
- Re-review the current artifact after remediation and verify finding closure.
- Keep reviewer identity, implementation version, timestamps, and correlation metadata auditable.

## Finding Rules

- `BLOCKING` prevents the affected workstream and applicable broader dependencies from completing.
- `REQUIRED_FIX` blocks the affected workstream and its direct dependents; unrelated workstreams continue.
- `ADVISORY` requires an owner and disposition but does not block completion.
- Findings are never closed by changing a workstream status.
- Evidence tied to a changed commit, artifact, deployment, dependency, configuration, or contract is stale and must be regenerated.

## Remediation

The reviewer writes the full finding to Lakebase. The Supervisor sends only a bounded reference envelope containing the review, finding, workstream, attempt, and required action identifiers. The original workstream is the default remediation owner; a separate remediation workstream is used when independent ownership or specialized capability is required.

The reviewer may recommend completion, but only the Supervisor-authorized path can mark the workstream `COMPLETE`.
