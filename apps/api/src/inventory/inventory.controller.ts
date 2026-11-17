import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash, timingSafeEqual } from 'node:crypto';
import { InventoryService } from './inventory.service.js';
import { SellMedicineDto } from './sell-medicine.dto.js';

const demoTenantId = '11111111-1111-4111-8111-111111111111';
const digest = (value: string) => createHash('sha256').update(value).digest();

@Controller('inventory')
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
    @Headers('idempotency-key') key?: string,
    @Headers('x-dev-token') token?: string,
  ) {
    const expected = process.env.DEV_API_TOKEN;
    if (process.env.NODE_ENV !== 'development' || !expected) {
      throw new ServiceUnavailableException(
        'Development inventory endpoint disabled',
      );
    }
    if (!token || !timingSafeEqual(digest(token), digest(expected))) {
      throw new UnauthorizedException('Invalid development token');
    }
    if (!key || !isUUID(key)) {
      throw new BadRequestException('Idempotency-Key must be a UUID');
    }
    return this.inventory.sell({
      tenantId: demoTenantId,
      pharmacyId: body.pharmacyId.toLowerCase(),
      medicineId: body.medicineId.toLowerCase(),
      quantity: body.quantity,
      idempotencyKey: key.toLowerCase(),
    });
  }
}
