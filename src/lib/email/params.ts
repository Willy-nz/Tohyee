/** A statement's options from a query string (statementKind, from, to, asAt, includeSubCustomers). */
export function statementFromParams(params: URLSearchParams): Record<string, unknown> {
  return {
    statementKind: params.get("statementKind") ?? undefined,
    from: params.get("from"),
    to: params.get("to"),
    asAt: params.get("asAt"),
    includeSubCustomers: params.get("includeSubCustomers"),
  };
}
