import {
  createParamDecorator,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MutationPrincipal } from '../mutation/mutation.types.js';
import { PROJECT, type Project } from './project.js';

export interface ProjectSession {
  principal: MutationPrincipal;
  scopes: string[];
  expiresAt: number;
}

interface ProjectRequest {
  headers: { authorization?: string };
  session?: ProjectSession;
}

@Injectable()
export class ProjectAuthGuard implements CanActivate {
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(PROJECT) private readonly project: Project) {
    if ('jwks' in project.auth) {
      if (project.auth.jwks.protocol !== 'https:')
        throw new Error('JWKS must use HTTPS');
      this.jwks = createRemoteJWKSet(project.auth.jwks);
    } else if (
      !['development', 'test'].includes(process.env.NODE_ENV ?? '') ||
      project.auth.developmentKey.byteLength < 32
    ) {
      throw new Error(
        'A development JWT key requires development/test mode and at least 32 bytes',
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ProjectRequest>();
    const token = /^Bearer ([\w.-]+)$/i.exec(
      request.headers.authorization ?? '',
    )?.[1];
    if (!token) throw new UnauthorizedException('Bearer token required');

    try {
      const options = {
        issuer: this.project.issuer,
        audience: this.project.audience,
        requiredClaims: ['sub', 'exp', 'iat', 'tenant_id'],
        maxTokenAge: '1h',
      };
      const { payload } = this.jwks
        ? await jwtVerify(token, this.jwks, {
            ...options,
            algorithms: ['RS256'],
          })
        : await jwtVerify(
            token,
            'developmentKey' in this.project.auth
              ? this.project.auth.developmentKey
              : new Uint8Array(),
            {
              ...options,
              algorithms: ['HS256'],
            },
          );
      if (
        payload.aud !== this.project.audience ||
        typeof payload.sub !== 'string' ||
        !isUUID(payload.sub) ||
        typeof payload.tenant_id !== 'string' ||
        !isUUID(payload.tenant_id) ||
        typeof payload.scope !== 'string' ||
        typeof payload.exp !== 'number' ||
        typeof payload.iat !== 'number' ||
        payload.exp > payload.iat + 3600
      ) {
        throw new Error('Invalid claims');
      }
      const pharmacies = payload.pharmacy_ids ?? [];
      if (
        !Array.isArray(pharmacies) ||
        !pharmacies.every((id: unknown) => typeof id === 'string' && isUUID(id))
      ) {
        throw new Error('Invalid pharmacy claims');
      }
      request.session = {
        principal: {
          userId: payload.sub.toLowerCase(),
          tenantId: payload.tenant_id.toLowerCase(),
          roles: [],
          allowedPharmacyIds: pharmacies.map((id: string) => id.toLowerCase()),
        },
        scopes: payload.scope.split(/\s+/),
        expiresAt: payload.exp * 1000,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid project token');
    }
  }
}

export const Session = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<ProjectRequest>().session,
);
