import { randomUUID } from 'node:crypto';
import { parseStockChange } from './redis-invalidation.service.js';

const event = {
  eventId: randomUUID(),
  type: 'stock.updated',
  tenantId: randomUUID(),
  aggregateId: randomUUID(),
};

it('validates the versioned stock event and extracts both pharmacies', () => {
  const pharmacy = randomUUID();
  const payload = {
    schemaVersion: 1,
    tenantId: event.tenantId,
    table: 'stocks',
    documentId: event.aggregateId,
    operation: 'update',
    before: { pharmacy_id: pharmacy, quantity: 2 },
    after: { pharmacy_id: pharmacy, quantity: 1 },
  };
  expect(parseStockChange(JSON.stringify({ ...event, payload }))).toEqual({
    tenantId: event.tenantId,
    table: 'stocks',
    documentId: event.aggregateId,
    operation: 'update',
    before: { pharmacy_id: pharmacy, quantity: 2 },
    after: { pharmacy_id: pharmacy, quantity: 1 },
  });
  expect(
    parseStockChange(
      JSON.stringify({
        ...event,
        payload: { ...payload, tenantId: randomUUID() },
      }),
    ),
  ).toBeUndefined();
  expect(
    parseStockChange(
      JSON.stringify({ ...event, payload: { ...payload, schemaVersion: 99 } }),
    ),
  ).toBeUndefined();
});

it('handles earlier outbox rows conservatively and ignores malformed messages', () => {
  expect(
    parseStockChange(
      JSON.stringify({ ...event, payload: { remainingQuantity: 1 } }),
    ),
  ).toEqual({
    tenantId: event.tenantId,
    table: 'stocks',
    documentId: event.aggregateId,
    operation: 'update',
  });
  expect(parseStockChange('invalid JSON')).toBeUndefined();
});
