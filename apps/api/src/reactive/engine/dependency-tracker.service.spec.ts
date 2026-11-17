import { DependencyTrackerService } from './dependency-tracker.service.js';

describe('DependencyTrackerService', () => {
  let service: DependencyTrackerService;

  beforeEach(() => {
    service = new DependencyTrackerService();
  });

  it('deduplicates identical dependencies', () => {
    const collector = service.createCollector();

    const dependency = {
      kind: 'document' as const,
      tenantId: 'tenant-a',
      table: 'stocks',
      documentId: 'stock-1',
    };

    collector.add(dependency);
    collector.add(dependency);

    expect(collector.snapshot()).toHaveLength(1);
  });

  it('isolates dependencies between executions', () => {
    const first = service.createCollector();
    const second = service.createCollector();

    first.add({
      kind: 'table',
      tenantId: 'tenant-a',
      table: 'stocks',
    });

    expect(first.snapshot()).toHaveLength(1);
    expect(second.snapshot()).toHaveLength(0);
  });
});
