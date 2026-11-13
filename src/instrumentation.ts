import type { Instrumentation } from "next";
import { log } from "@/lib/log";

/**
 * Server-side error hook (M9-T5): every unhandled error in a route, page or action becomes one structured
 * log line that a log drain or monitoring vendor can alert on. Only the class name, Next's opaque `digest`,
 * the route pattern and the path WITHOUT its query string are logged: messages, stacks and query strings
 * (order access tokens travel in `?t=`) can carry customer data.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const e = error as { name?: string; digest?: string };
  log.error("request.unhandled_error", {
    errorName: typeof e?.name === "string" ? e.name : "unknown",
    digest: e?.digest,
    method: request.method,
    path: request.path.split("?")[0],
    routePath: context.routePath,
    routeType: context.routeType,
  });
};
