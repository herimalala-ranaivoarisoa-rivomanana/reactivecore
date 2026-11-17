import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { InventoryRepository } from './inventory.repository.js';
import type {
  MutationContext,
  MutationPrincipal,
} from '../mutation/mutation.types.js';
import { ReactiveMutation } from '../mutation/reactive-mutation.decorator.js';

interface TransferArgs {
  sourcePharmacyId: string;
  destinationPharmacyId: string;
  medicineId: string;
  quantity: number;
  expectedSourceVersion?: string;
  expectedDestinationVersion?: string;
}

function validateTransfer(raw: unknown): TransferArgs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Transfer arguments must be an object');
  }
  const args = raw as Record<string, unknown>;
  const allowed = [
    'sourcePharmacyId',
    'destinationPharmacyId',
    'medicineId',
    'quantity',
    'expectedSourceVersion',
    'expectedDestinationVersion',
  ];
  if (Object.keys(args).some((key) => !allowed.includes(key))) {
    throw new BadRequestException('Unexpected transfer argument');
  }
  function uuid(field: string): string {
    const value = args[field];
    if (typeof value !== 'string' || !isUUID(value))
      throw new BadRequestException(`${field} must be a UUID`);
    return value.toLowerCase();
  }
  function version(field: string): string | undefined {
    if (!Object.hasOwn(args, field)) return;
    const value = args[field];
    if (
      typeof value !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(value) ||
      BigInt(value) > 9223372036854775807n
    ) {
      throw new BadRequestException(
        `${field} must be a positive BIGINT string`,
      );
    }
    return value;
  }

  const sourcePharmacyId = uuid('sourcePharmacyId');
  const destinationPharmacyId = uuid('destinationPharmacyId');
  if (sourcePharmacyId === destinationPharmacyId)
    throw new BadRequestException('Source and destination must differ');
  const quantity = args.quantity;
  if (
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 1_000_000
  ) {
    throw new BadRequestException(
      'Quantity must be an integer between 1 and 1000000',
    );
  }
  const expectedSourceVersion = version('expectedSourceVersion');
  const expectedDestinationVersion = version('expectedDestinationVersion');
  return {
    sourcePharmacyId,
    destinationPharmacyId,
    medicineId: uuid('medicineId'),
    quantity,
    ...(expectedSourceVersion ? { expectedSourceVersion } : {}),
    ...(expectedDestinationVersion ? { expectedDestinationVersion } : {}),
  };
}

function authorizeTransfer(
  principal: MutationPrincipal,
  args: TransferArgs,
): void {
  if (
    !principal.allowedPharmacyIds.includes(args.sourcePharmacyId) ||
    !principal.allowedPharmacyIds.includes(args.destinationPharmacyId)
  ) {
    throw new ForbiddenException('Pharmacy not authorized');
  }
}

@Injectable()
export class TransferMutationService {
  constructor(private readonly inventory: InventoryRepository) {}

  @ReactiveMutation({
    name: 'inventory.transfer',
    validate: validateTransfer,
    authorize: authorizeTransfer,
  })
  async transfer(
    { client, principal, recordChange }: MutationContext,
    args: TransferArgs,
  ) {
    const tenantId = principal.tenantId;
    const pharmacyIds = [args.sourcePharmacyId, args.destinationPharmacyId];
    if (
      (await this.inventory.countPharmacies(client, tenantId, pharmacyIds)) !==
      2
    ) {
      throw new ForbiddenException('Pharmacy not authorized');
    }
    const rows = await this.inventory.lockTransferStocks(
      client,
      tenantId,
      args.medicineId,
      pharmacyIds,
    );
    const source = rows.find(
      (row) => row.pharmacy_id === args.sourcePharmacyId,
    );
    const destination = rows.find(
      (row) => row.pharmacy_id === args.destinationPharmacyId,
    );
    if (
      (args.expectedSourceVersion &&
        source?.version !== args.expectedSourceVersion) ||
      (args.expectedDestinationVersion &&
        destination?.version !== args.expectedDestinationVersion)
    ) {
      throw new ConflictException('Expected stock version does not match');
    }
    if (!source || source.quantity < args.quantity)
      throw new ConflictException('Insufficient stock');
    if (destination && destination.quantity > 2147483647 - args.quantity) {
      throw new ConflictException('Destination stock exceeds capacity');
    }

    const debit = await this.inventory.adjustStock(
      client,
      tenantId,
      source,
      -args.quantity,
    );
    if (!debit)
      throw new ConflictException('Expected stock version does not match');
    const credit = destination
      ? await this.inventory.adjustStock(
          client,
          tenantId,
          destination,
          args.quantity,
        )
      : await this.inventory.insertStock(
          client,
          tenantId,
          args.destinationPharmacyId,
          args.medicineId,
          args.quantity,
        );
    if (!credit)
      throw new ConflictException('Destination stock changed concurrently');

    recordChange({
      table: 'stocks',
      documentId: debit.id,
      operation: 'update',
      before: { ...source },
      after: { ...debit },
    });
    recordChange({
      table: 'stocks',
      documentId: credit.id,
      operation: destination ? 'update' : 'insert',
      before: destination ? { ...destination } : null,
      after: { ...credit },
    });
    return {
      transferId: randomUUID(),
      source: {
        pharmacyId: debit.pharmacy_id,
        remaining: debit.quantity,
        version: debit.version,
      },
      destination: {
        pharmacyId: credit.pharmacy_id,
        quantity: credit.quantity,
        version: credit.version,
      },
    };
  }
}
