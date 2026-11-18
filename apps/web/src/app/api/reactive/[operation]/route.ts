import { forwardBackend } from "../../backend-proxy";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ operation: string }> },
) {
  const { operation } = await params;
  const target =
    operation === "subscribe"
      ? "/api/reactive/subscribe"
      : operation === "mutate"
        ? "/api/mutations/execute"
        : null;
  if (!target) return Response.json({ message: "Route inconnue" }, { status: 404 });

  return forwardBackend(
    request,
    process.env.REACTIVECORE_API_URL ?? "http://127.0.0.1:4000",
    target,
    "x-dev-token",
  );
}
