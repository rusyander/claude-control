import type { AttachRejection } from './plan.types';

/** Есть ли что сказать человеку. */
export function hasRejections(rejection: AttachRejection): boolean {
  return rejection.unsupported.length > 0 || rejection.tooLarge.length > 0;
}
