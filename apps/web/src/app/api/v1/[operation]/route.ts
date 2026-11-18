import { forwardBackend } from "../../backend-proxy";

function proxy(request: Request, operation: string) {
  return forwardBackend(
    request,
    process.env.REACTIVECORE_TASKS_URL ?? "http://127.0.0.1:4402",
    `/api/v1/${operation}`,
    "authorization",
  );
}

type Context = { params: Promise<{ operation: string }> };

export async function POST(request: Request, { params }: Context) {
  const { operation } = await params;
  if (!["query", "mutation", "subscribe"].includes(operation)) return new Response(null, { status: 404 });
  return proxy(request, operation);
}

export async function GET(request: Request, { params }: Context) {
  const { operation } = await params;
  if (operation !== "session") return new Response(null, { status: 404 });
  return proxy(request, operation);
}
