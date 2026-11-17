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
import { SubscriptionManagerService } from './subscriptions/subscription-manager.service.js';

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
  constructor(private readonly subscriptions: SubscriptionManagerService) {}

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

    response.status(200);
    const connection = new AbortController();
    let blocked = false;
    let pending: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    function close() {
      connection.abort();
      clearInterval(heartbeat);
      pending = undefined;
      response.off('drain', drain);
    }

    function write(frame: string) {
      if (connection.signal.aborted || response.destroyed) return;
      if (blocked) {
        pending = frame;
        return;
      }
      blocked = !response.write(frame);
    }

    function drain() {
      blocked = false;
      const frame = pending;
      pending = undefined;
      if (frame) write(frame);
    }

    response.once('close', close);
    response.on('drain', drain);
    try {
      await this.subscriptions.subscribe(
        principal,
        'stocks.list',
        {
          pharmacyId,
          availableOnly: body.args.availableOnly,
        },
        ({ snapshotSeq, data }) => {
          if (connection.signal.aborted || response.destroyed) return;
          if (!response.headersSent) {
            response.set({
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              'X-Accel-Buffering': 'no',
            });
            heartbeat = setInterval(() => {
              if (!blocked) write(': heartbeat\n\n');
            }, 15000);
            heartbeat.unref();
          }
          write(
            `id: ${snapshotSeq}\nevent: snapshot\ndata: ${JSON.stringify({ seq: snapshotSeq, data })}\n\n`,
          );
        },
        connection.signal,
      );
    } catch (error) {
      if (connection.signal.aborted) return;
      close();
      throw error;
    }
  }
}
