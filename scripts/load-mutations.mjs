import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

const requests = positiveInteger(process.argv[2] ?? '20', 'requests');
const concurrency = positiveInteger(process.argv[3] ?? '4', 'concurrency');
const port = positiveInteger(process.env.PORT ?? '4000', 'PORT');
const token = process.env.DEV_API_TOKEN;
if (!token) throw new Error('Set DEV_API_TOKEN in the local environment');
if (port > 65535) throw new Error('PORT must be at most 65535');

const pharmacies = [
  '22222222-2222-4222-8222-222222222222',
  '66666666-6666-4666-8666-666666666666',
];
const medicineId = '33333333-3333-4333-8333-333333333333';
const counts = {};
const latencies = [];
let next = 0;
const started = performance.now();

async function sendTransfers() {
  while (next < requests) {
    const index = next++;
    const from = index % pharmacies.length;
    const start = performance.now();
    let status;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/mutations/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
          'X-Dev-Token': token,
        },
        body: JSON.stringify({
          name: 'inventory.transfer',
          args: {
            sourcePharmacyId: pharmacies[from],
            destinationPharmacyId: pharmacies[1 - from],
            medicineId,
            quantity: 1,
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
      await response.arrayBuffer();
      status = String(response.status);
    } catch {
      status = 'network_error';
    }
    latencies.push(performance.now() - start);
    counts[status] = (counts[status] ?? 0) + 1;
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, sendTransfers));
const elapsed = (performance.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const percentile = (fraction) => Number(latencies[Math.ceil(latencies.length * fraction) - 1].toFixed(2));
console.log(JSON.stringify({
  requests,
  concurrency: Math.min(concurrency, requests),
  statuses: counts,
  requestsPerSecond: Number((requests / elapsed).toFixed(2)),
  successfulPerSecond: Number(((counts[200] ?? 0) / elapsed).toFixed(2)),
  latencyMs: { p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99) },
}, null, 2));
if (Object.keys(counts).some((status) => status !== '200' && status !== '409') || !counts[200]) {
  process.exitCode = 1;
}
