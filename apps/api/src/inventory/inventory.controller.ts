import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { isIdempotencyKey } from '../mutation/idempotency-key.js';
import {
  DevelopmentAuthGuard,
  DevelopmentPrincipal,
} from '../auth/development-auth.guard.js';
import type { QueryPrincipal } from '../reactive/contracts/query-context.js';
import { InventoryService } from './inventory.service.js';
import { SellMedicineDto } from './sell-medicine.dto.js';

@Controller('inventory')
@UseGuards(DevelopmentAuthGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('sell')
  @HttpCode(200)
  async sell(
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: SellMedicineDto,
    @DevelopmentPrincipal() principal: QueryPrincipal,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!isIdempotencyKey(key)) {
      throw new BadRequestException('Idempotency-Key must be a UUID');
    }
    return this.inventory.sell({
      tenantId: principal.tenantId,
      pharmacyId: body.pharmacyId.toLowerCase(),
      medicineId: body.medicineId.toLowerCase(),
      quantity: body.quantity,
      idempotencyKey: key.toLowerCase(),
    });
  }
}
