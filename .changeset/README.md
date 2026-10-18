# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

When you make a user-visible change to Payment Providers, run:

```bash
npx changeset
```

Select package **`@idevconn/payment-providers`** and the appropriate semver bump. A markdown file in this directory records the change. The Release workflow merges these into `CHANGELOG.md` and bumps the version when a release PR is merged to `main`.
