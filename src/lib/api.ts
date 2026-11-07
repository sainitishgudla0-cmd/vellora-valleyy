import { NextResponse } from "next/server";
import { ZodError, type ZodSchema } from "zod";
import { fieldErrors } from "./validation";

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
export const fail = (error: string, status = 400, fields?: Record<string, string>) => NextResponse.json({ error, fields }, { status });

export async function parseBody<T>(req: Request, schema: ZodSchema<T>): Promise<{ data: T } | { response: NextResponse }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { response: fail("Invalid request body", 400) };
  }
  const r = schema.safeParse(body);
  if (!r.success) return { response: fail("Please check the highlighted fields.", 422, fieldErrors(r.error as ZodError)) };
  return { data: r.data };
}
