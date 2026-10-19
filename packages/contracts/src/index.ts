/** Version of the contracts shared between NimbleNewt packages. Bump on breaking changes. */
export const CONTRACTS_VERSION = 1;

/** Caller-chosen identifier that makes a submission idempotent: the same ID yields the original result. */
export type RequestId = string & { readonly __brand: "RequestId" };

export function requestId(value: string): RequestId {
  if (value.length === 0) throw new Error("request ID must not be empty");
  return value as RequestId;
}
