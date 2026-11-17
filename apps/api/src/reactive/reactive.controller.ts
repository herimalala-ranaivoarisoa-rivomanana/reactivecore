import {
  Body,
  Controller,
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
import type { QueryPrincipal } from './contracts/query-context.js';
import { QueryExecutorService } from './engine/query-executor.service.js';

class QueryBody {
  @IsString()
  @Matches(/^[a-z][a-z0-9_.-]{1,127}$/)
  name!: string;

  @IsDefined()
  args!: unknown;
}

@Controller('reactive')
@UseGuards(DevelopmentAuthGuard)
export class ReactiveController {
  constructor(private readonly executor: QueryExecutorService) {}

  @Post('query')
  @HttpCode(200)
  execute(
    @DevelopmentPrincipal() principal: QueryPrincipal,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: QueryBody,
  ) {
    return this.executor.execute(principal, body.name, body.args);
  }
}
