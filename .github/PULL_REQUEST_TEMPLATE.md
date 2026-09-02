## What this changes

<!-- One or two sentences. What does this add, fix, or change? -->

## Why

<!-- What problem does it solve? Link an issue if there is one. -->

## How I tested it

<!-- Please be specific. "Deployed to my account and loaded all three tabs" is
     more useful than "tested locally". -->

- [ ] `npm run build` succeeds
- [ ] Deployed with `snow app deploy` and the app loads
- [ ] Summary / Deep dive / Controls tabs all render
- [ ] Verified against my own `ACCOUNT_USAGE` data (if this touches queries)

## Cost and correctness

<!-- Delete any that don't apply. -->

- [ ] Any new `ACCOUNT_USAGE` query is UTC-anchored (see `lib/cost-queries.ts`)
- [ ] Credits are converted to dollars using the correct rate (AI vs platform — see `lib/credit-kind.ts`)
- [ ] Any new object name, tag, or user input passed into SQL is validated

## Anything else

<!-- Screenshots are very welcome for UI changes. Light and dark mode if relevant. -->

---

Thanks for contributing. All pull requests are reviewed by the maintainer
before merging — nothing lands on `main` automatically.
