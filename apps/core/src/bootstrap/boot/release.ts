import type { Note } from './boot.types.ts';

export const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Шаги освобождения по порядку; сбой одного не отменяет следующих — он возвращается. */
export async function releaseAll(
  steps: readonly (() => unknown)[],
  note: Note,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
      note('release.failed', { reason: reasonOf(error) });
    }
  }
  return failures;
}
