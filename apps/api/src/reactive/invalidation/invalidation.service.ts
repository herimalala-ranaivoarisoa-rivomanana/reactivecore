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
        this.matchesOrUnknown(dependency.equals, change.before)) ||
      (change.operation !== 'delete' &&
        this.matchesOrUnknown(dependency.equals, change.after))
    );
  }

  private matchesOrUnknown(
    equals: Record<string, string>,
    row: Record<string, unknown> | undefined,
  ): boolean {
    if (!row) return true;

    return Object.entries(equals).every(([field, expected]) => {
      if (!Object.hasOwn(row, field)) return true;
      return row[field] === expected;
    });
  }
}
