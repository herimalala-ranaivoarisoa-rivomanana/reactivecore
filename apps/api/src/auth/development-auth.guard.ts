import {
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { QueryPrincipal } from '../reactive/contracts/query-context.js';

interface DevelopmentRequest {
  headers: { 'x-dev-token'?: string | string[] };
  principal?: QueryPrincipal;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

@Injectable()
export class DevelopmentAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.DEV_API_TOKEN;
    if (process.env.NODE_ENV !== 'development' || !expected) {
      throw new ServiceUnavailableException('Development endpoint disabled');
    }
    const request = context.switchToHttp().getRequest<DevelopmentRequest>();
    const token = request.headers['x-dev-token'];
    if (
      typeof token !== 'string' ||
      !timingSafeEqual(digest(token), digest(expected))
    ) {
      throw new UnauthorizedException('Invalid development token');
    }
    request.principal = {
      userId: '55555555-5555-4555-8555-555555555555',
      tenantId: '11111111-1111-4111-8111-111111111111',
      roles: ['developer'],
    };
    return true;
  }
}

export const DevelopmentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<DevelopmentRequest>().principal,
);
