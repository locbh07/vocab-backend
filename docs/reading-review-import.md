# Import reviewed readings

The 2026-11-18 returned ZIP failed contextual sampling (pronoun 君 read as くん,
person 方 as ほう in completed items). No data from that ZIP was imported.
Structural validation alone is insufficient; obtain corrected editorial results
and repeat contextual sampling before applying any import.

`scripts/import-reading-review.cjs` validates every batch against the original
v2 export, then compares the current database explanation and source context.
It skips needs_human_review items and conflicts, writes a full rollback.jsonl
before its first mutation, and uses conditional updates in transactions of 25.
Default mode is read-only dry-run. Select `.env.local` or `.env.production`
explicitly with `--env`; never switch or rewrite environment files.

Arguments: `--env=production --input=backups/<v2-export> --results=backups/<returned>/RESULTS --out=backups/<new-run>`.
Add `--apply` only after semantic review. Each run requires a new output folder.
No schema migration is required. Metadata is stored under `_reading_review` in
explanation_json; original content stays intact. API hydration reapplies reviewed
readings after tokenizer output. Per-field source checks invalidate annotations
when content changes; exact full-field rendering avoids a global word dictionary.
Cache upserts retain metadata, but changed field texts do not reuse it.

If rollback is necessary, use each journal row's `before` document and restore
only rows still matching that row's `before` plus imported `metadata`; any later
editorial changes must be reviewed separately, never overwritten blindly.
