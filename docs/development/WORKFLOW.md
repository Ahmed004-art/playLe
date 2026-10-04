# Development Workflow

## Phase Pipeline

PlayLe is built in explicit, sequential phases. Each phase has its own
specification and its own "do not build yet" list, enforced by `CLAUDE.md`.

```
Requirement
    |
Architecture / specification
    |
Implementation
    |
Tests
    |
Review
    |
Fixes
    |
Verification
    |
Commit
    |
Phase approval
    |
Next phase
```

The implementer (Claude Code or a human engineer) must **stop after
completing the current phase's Definition of Done** and report status
rather than automatically continuing into the next phase. Phase approval
is an explicit, external decision, not something the implementer grants
itself.

## Day-to-Day Loop

1. Read the current phase's specification and relevant docs
   (`docs/architecture/`, `docs/decisions/`) before writing code.
2. Inspect existing code in the area you're about to touch.
3. Implement the smallest change that satisfies the requirement.
4. Run the relevant tests, lint, and typecheck for anything you touched.
5. Fix anything that fails — do not report success with failing checks.
6. Commit with a meaningful message describing *why*, not just *what*.

## Commit Messages

Use conventional, descriptive messages, e.g.:

```
feat: initialize PlayLe project foundation
feat(api): add health check module with Postgres and Redis indicators
docs: add ADR-009 financial ledger decision
fix(admin): correct API client base URL resolution
```

Avoid meaningless messages (`update`, `changes`, `stuff`, `fix`).

## Definition of Done (Per Change, Not Just Per Phase)

A change is done when:

- It satisfies the current phase's specification (no scope creep into a
  later phase).
- Relevant tests pass.
- Relevant lint/typecheck/build passes.
- Documentation is updated if the change affects architecture, setup, or
  commands.
- No secrets were introduced (see `docs/architecture/SECURITY.md`).

## When to Stop and Ask

Stop and report rather than deciding unilaterally when:

- A requirement is ambiguous in a way that affects architecture (not just
  a naming/style choice).
- Implementing the request would require building something explicitly
  listed as out-of-scope for the current phase.
- A change would be destructive or hard to reverse (force-push, dropping
  data, rewriting history) without explicit instruction to do so.

## Verification Before Claiming Completion

Never report a command "passes" without having actually run it in this
session. If something cannot be verified in the current environment (e.g.
no Docker available, no macOS for an iOS build), say so explicitly —
`NOT VERIFIED` — and explain why, rather than assuming success.
