export async function forwardBackend(
  request: Request,
  origin: string,
  path: string,
  authHeader: string,
) {
  const token = request.headers.get(authHeader);
  if (!token) return Response.json({ message: "Jeton requis" }, { status: 401 });

  const headers = new Headers({ [authHeader]: token, "Content-Type": "application/json" });
  const key = request.headers.get("idempotency-key");
  if (key) headers.set("Idempotency-Key", key);

  let body: string | undefined;
  if (request.method === "POST") {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ message: "Corps requis" }, { status: 400 });
    const decoder = new TextDecoder();
    let size = 0;
    body = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16_384) {
          await reader.cancel();
          return Response.json({ message: "Requête trop volumineuse" }, { status: 413 });
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }

  try {
    const upstream = await fetch(new URL(path, origin), {
      method: request.method, headers, body, signal: request.signal, redirect: "error", cache: "no-store",
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
