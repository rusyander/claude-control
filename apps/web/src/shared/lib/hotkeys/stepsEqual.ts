import type { KeyStep } from './hotkeys.types';

/** Два шага совпадают, когда совпали и клавиша, и признак модификатора. */
export function stepsEqual(a: KeyStep, b: KeyStep): boolean {
  return a.key === b.key && a.mod === b.mod;
}
