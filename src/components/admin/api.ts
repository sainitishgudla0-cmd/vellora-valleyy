/** Tiny fetch helper for the admin dashboard's client components (same-origin, cookie session). */
export interface ApiResult {
  ok: boolean;
  status: number;
  data: Record<string, any>;
}

export async function adminApi(method: string, url: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, data: { error: "Network error. Please try again." } };
  }
}

/** The most specific message the API gave: a field error first, then the general one. */
export function errorText(r: ApiResult): string {
  const fields = r.data.fields as Record<string, string> | undefined;
  const first = fields ? Object.values(fields)[0] : undefined;
  return first || (r.data.error as string | undefined) || "Something went wrong";
}
