import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Post,
  Res,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsObject,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import {
  DevelopmentAuthGuard,
  DevelopmentPrincipal,
} from '../auth/development-auth.guard.js';
import type { MutationPrincipal } from '../mutation/mutation.types.js';
import { ReactiveStreamService } from './reactive-stream.service.js';

class StockStreamArgs {
  @IsUUID()
  pharmacyId!: string;

  @IsBoolean()
  availableOnly = false;
}

class StockStreamBody {
  @IsIn(['inventory.list', 'stocks.list'])
  name!: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => StockStreamArgs)
  args!: StockStreamArgs;
}

@Controller('reactive')
@UseGuards(DevelopmentAuthGuard)
export class ReactiveStreamController {
  constructor(private readonly stream: ReactiveStreamService) {}

  @Post('subscribe')
  async subscribe(
    @DevelopmentPrincipal() principal: MutationPrincipal,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: StockStreamBody,
    @Res() response: Response,
  ): Promise<void> {
    if (!body.args)
      throw new BadRequestException('Stock query arguments are required');
    const pharmacyId = body.args.pharmacyId.toLowerCase();
    if (!principal.allowedPharmacyIds.includes(pharmacyId)) {
      throw new ForbiddenException('Pharmacy not authorized');
    }

    await this.stream.open(response, principal, 'stocks.list', {
      pharmacyId,
      availableOnly: body.args.availableOnly,
    });
  }
}
