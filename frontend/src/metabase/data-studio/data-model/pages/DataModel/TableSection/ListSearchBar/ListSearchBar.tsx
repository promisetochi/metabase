/** Case-insensitive match on any of the item's names */
export function matchesListSearch(
  query: string,
  ...names: (string | null | undefined)[]
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  return (
    normalizedQuery === "" ||
    names.some((name) => name?.toLowerCase().includes(normalizedQuery))
  );
}
