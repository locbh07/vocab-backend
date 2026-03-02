# Grammar Reclassify Workflow

This project now supports source-based grammar organization:

- `N5` -> `minna1`
- `N4` -> `minna2`
- `N3` -> `shinkanzen_n3`
- `N2` -> `shinkanzen_n2`
- `N1` -> `shinkanzen_n1`

New grammar columns:

- `source_book` (book key)
- `source_unit` (lesson/chapter label)
- `track` (`core` or `supplemental`)
- `priority` (display order in each level)

## Commands

1. Reclassify existing rows:

```bash
npm run grammar:reclassify
```

2. Add baseline missing grammar candidates:

```bash
npm run grammar:seed:baseline
```

3. Map `source_unit` labels:

```bash
npm run grammar:map:units
```

Notes:

- Reclassify marks cross-level duplicate grammar points as `supplemental` in higher levels.
- Seed is conservative and only inserts points not already present in the same level.
- Unit mapping assigns `Lesson 01..25` for N5/N4 and `Chapter 01..20` for N3/N2/N1 by priority order.
- You can edit `scripts/seed-grammar-missing-baseline.cjs` to adjust the candidate list.
