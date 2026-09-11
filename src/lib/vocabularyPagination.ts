export function vocabularyPagination(query: Record<string, unknown>) {
  const limit = query.limit === undefined ? 250 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
    return null;
  }
  return { take: Math.min(limit, 500), skip: offset };
}
