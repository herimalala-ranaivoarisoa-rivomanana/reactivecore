import type { Type } from '@nestjs/common';
import type { MutationPrincipal } from '../mutation/mutation.types.js';

export const PROJECT = Symbol('reactivecore.project');

export type Operation = 'query' | 'mutation' | 'subscribe';

export interface Project {
  issuer: string;
  audience: string;
  auth: { jwks: URL } | { developmentKey: Uint8Array };
  application: Type<unknown>;
  functions: {
    queries: Readonly<
      Record<string, (principal: MutationPrincipal, args: unknown) => void>
    >;
    mutations: readonly string[];
  };
}
