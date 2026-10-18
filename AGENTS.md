# @idevconn/payment-providers — extraction engagement

## Paths

| Role | Path |
| --- | --- |
| Source (read-only unless integration approved) | `/Users/kudenv/pr/www/idevcon/EmployeeDrivenContent` |
| Target npm package | `/Users/kudenv/pr/www/idevcon/payment-providers-module` |
| Generic scaffold reference | `/Volumes/Project/idevconn/npm-scafolding/AGENTS.md` |

## Objective

Extract reusable payment contracts, provider-neutral core, and the PayPal adapter from EmployeeDrivenContent into `@idevconn/payment-providers` without changing host behavior until a separate integration phase.

## Fixed npm scope

Scope is always `@idevconn`. Package name: `@idevconn/payment-providers`.

## Phases (separate approvals)

1. **Discovery / plan** — read-only on source.
2. **Extract** — create and edit files only under `payment-providers-module`.
3. **Verify** — install, lint, typecheck, test, build, pack (explicit approval per command batch).
4. **Integrate** — change EmployeeDrivenContent imports/deps (explicit approval).
5. **Legacy cleanup** — remove in-repo `libs/payment-*` after parity (explicit approval).
6. **Publish** — npm publish, tags, Changesets (explicit approval).

## Prohibited without approval

- Edits under `EmployeeDrivenContent` during extraction.
- Deleting or moving legacy payment code in the host.
- Git commit, push, tag, publish.
- Database migrations or hosted mutation.

## Authority in source

`EmployeeDrivenContent/Payment/ARCHITECTURE.md` governs financial boundaries between reusable payment and EDC product code.

## Workflow

Follow scaffold sequence: DISCOVER → CLASSIFY → PLAN → CONFIRM → IMPLEMENT → VERIFY → REPORT. Planning approval is not implementation approval.
