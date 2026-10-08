import type { CreateTarget } from './createTarget.types';

/** Поле ввода в корне ресурса, а не в папке. */
export const CREATE_IN_ROOT = '';

/** Открыто ли поле именно в этой папке ('' — корень). */
export function isCreatingIn(state: CreateTarget, folder: string): boolean {
  return state === folder;
}
