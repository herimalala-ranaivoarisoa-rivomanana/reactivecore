import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { IsDefined, IsString, Matches } from 'class-validator';
import {
  DevelopmentAuthGuard,
  DevelopmentPrincipal,
} from '../auth/development-auth.guard.js';
import { MutationEngineService } from './mutation-engine.service.js';
import type { MutationPrincipal } from './mutation.types.js';

class MutationBody {
  @IsString()
  @Matches(/^[a-z][a-z0-9_.-]{1,127}$/)
  name!: string;

  @IsDefined()
  args!: unknown;
}

@Controller('mutations')
@UseGuards(DevelopmentAuthGuard)
export class MutationController {
  constructor(private readonly engine: MutationEngineService) {}

  @Post('execute')
  @HttpCode(200)
  execute(
    @DevelopmentPrincipal() principal: MutationPrincipal,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: MutationBody,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.engine.execute({
      principal,
      name: body.name,
      args: body.args,
      idempotencyKey: key ?? '',
    });
  }
}
