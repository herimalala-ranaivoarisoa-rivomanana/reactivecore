export const INVALIDATION_CHANNEL = 'reactivecore:invalidation';

export function invalidationChannel(): string {
  return process.env.RC_INVALIDATION_CHANNEL ?? INVALIDATION_CHANNEL;
}
