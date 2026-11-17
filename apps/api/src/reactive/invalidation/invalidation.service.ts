import { Injectable } from '@nestjs/common';

import type {
  ChangeDescriptor,
  Dependency,
} from '../contracts/dependency.types.js';

@Injectable()
export class InvalidationService {
  affects(dependency: Dependency, change: ChangeDescriptor): boolean {
    if (dependency.tenantId !== change.tenantId) {
      return false;
    }

    if (dependency.table !== change.table) {
      return false;
    }

    if (dependency.kind === 'table') {
      return true;
    }

    if (dependency.kind === 'document') {
      return dependency.documentId === change.documentId;
    }

    // Une dépendance de prédicat peut être affectée
    // si l'ancienne OU la nouvelle ligne correspond.
    // Si les données nécessaires sont absentes,
    // on invalide par prudence.
    return (
      (change.operation !== 'insert' &&
        this.matchesOrUnknown(dependency, change.before)) ||
      (change.operation !== 'delete' &&
        this.matchesOrUnknown(dependency, change.after))
    );
  }

  private matchesOrUnknown(
    predicate: Extract<Dependency, { kind: 'predicate' }>,
    row: ChangeDescriptor['before'],
  ): boolean {
    if (row === null) return false;
    if (row === undefined) return true;

    for (const [field, expected] of Object.entries(predicate.equals)) {
      if (Object.hasOwn(row, field) && row[field] !== expected) return false;
    }
    for (const [field, range] of Object.entries(predicate.ranges ?? {})) {
      const value = row[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (range.gt !== undefined && value <= range.gt) return false;
      if (range.gte !== undefined && value < range.gte) return false;
      if (range.lt !== undefined && value >= range.lt) return false;
      if (range.lte !== undefined && value > range.lte) return false;
    }
    return true;
  }
}
