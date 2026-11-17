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

  const token = request.headers.get("x-dev-token");
  if (!token) return Response.json({ message: "Jeton requis" }, { status: 401 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ message: "Corps requis" }, { status: 400 });
  const decoder = new TextDecoder();
  let input = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        return Response.json({ message: "Requête trop volumineuse" }, { status: 413 });
      }
      input += decoder.decode(value, { stream: true });
    }
    input += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Dev-Token": token,
  });
  const key = request.headers.get("idempotency-key");
  if (key) headers.set("Idempotency-Key", key);

  try {
    const api = process.env.REACTIVECORE_API_URL ?? "http://127.0.0.1:4000";
    const upstream = await fetch(new URL(target, api), {
      method: "POST",
      headers,
      body: input,
      cache: "no-store",
      redirect: "error",
      signal: request.signal,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return Response.json({ message: "API indisponible" }, { status: 502 });
  }
}
