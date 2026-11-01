export type Fetch = typeof fetch;

export async function jsonRpc<T>(
  url: string,
  method: string,
  params: unknown,
  fetchFn: Fetch = fetch,
): Promise<T> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message?: string; data?: unknown } };
  if (body.error) {
    throw new RpcError(body.error.message ?? JSON.stringify(body.error), body.error.data);
  }
  return body.result as T;
}

export class RpcError extends Error {
  readonly data: unknown;

  constructor(message: string, data?: unknown) {
    super(message);
    this.data = data;
  }
}

/** A NEAR view call, decoded as JSON. */
export async function nearView<T>(
  rpc: string,
  accountId: string,
  method: string,
  args: unknown,
  fetchFn: Fetch = fetch,
): Promise<T> {
  const result = await jsonRpc<{ result: number[] }>(
    rpc,
    "query",
    {
      request_type: "call_function",
      finality: "final",
      account_id: accountId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
    fetchFn,
  );
  return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
}
