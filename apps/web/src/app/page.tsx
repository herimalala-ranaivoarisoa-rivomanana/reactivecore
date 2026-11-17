import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

type HealthResponse = {
  status: "healthy" | "degraded";
  services: {
    postgres: "up" | "down";
    redis: "up" | "down";
  };
  timestamp: string;
};

async function getHealth(): Promise<HealthResponse> {
  const baseUrl =
    process.env.REACTIVECORE_API_URL ??
    "http://127.0.0.1:4000";

  const response = await fetch(
    `${baseUrl}/api/health`,
    {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    },
  );

  if (!response.ok) {
    throw new Error("ReactiveCore API unavailable");
  }

  return response.json();
}

async function InfrastructureStatus() {
  await connection();

  let health: HealthResponse | null = null;

  try {
    health = await getHealth();
  } catch (error) {
    console.error("Health request failed:", error);
  }

  if (!health) {
    return <p>Backend unavailable</p>;
  }

  return (
    <ul>
      <li>API: {health.status}</li>
      <li>PostgreSQL: {health.services.postgres}</li>
      <li>Redis: {health.services.redis}</li>
      <li>Checked at: {health.timestamp}</li>
    </ul>
  );
}

export default function Home() {
  return (
    <main style={{
      maxWidth: 800,
      margin: "50px auto",
      fontFamily: "sans-serif",
    }}>
      <h1>ReactiveCore</h1>

      <p>
        Next.js 16.4 + NestJS + PostgreSQL + Redis
      </p>

      <p><Link href="/inventory">Ouvrir le laboratoire des stocks en direct</Link></p>

      <h2>Infrastructure Status</h2>

      <Suspense fallback={<p>Checking infrastructure…</p>}>
        <InfrastructureStatus />
      </Suspense>
    </main>
  );
}
