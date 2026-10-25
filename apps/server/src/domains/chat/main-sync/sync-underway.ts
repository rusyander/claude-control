import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inTarget, runGit, type GitRunner } from './conflicts.ts';

/** Файл состояния git копии (`rebase-merge/onto`, …) — его текст или `undefined`. */
async function gitStateFile(
  cwd: string,
  name: string,
  run: GitRunner,
): Promise<string | undefined> {
  const located = await run(cwd, ['rev-parse', '--git-path', name], 5_000);
  const where = located.stdout.trim();
  if (located.code !== 0 || !where) return undefined;
  const text = await readFile(path.resolve(cwd, where), 'utf8').catch(() => undefined);
  return text?.trim() || undefined;
}

/**
 * Что приносит идущая операция git и что было до неё: перебазирование —
 * `onto` и `orig-head`, слияние и перенос коммита — `MERGE_HEAD` /
 * `CHERRY_PICK_HEAD` и HEAD. Операции нет — `undefined`.
 */
async function operationUnderway(
  cwd: string,
  run: GitRunner,
): Promise<{ incoming: string; before: string } | undefined> {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const onto = await gitStateFile(cwd, `${dir}/onto`, run);
    const before = await gitStateFile(cwd, `${dir}/orig-head`, run);
    if (onto && before) return { incoming: onto, before };
  }
  for (const head of ['MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
    const incoming = (await gitStateFile(cwd, head, run))?.split(/\s+/)[0];
    if (incoming) return { incoming, before: 'HEAD' };
  }
  return undefined;
}

/**
 * Догон целевой ветки уже идёт в копии (перебазирование, слияние или перенос
 * коммита, чьё «приносимое» лежит в целевой и не лежало в ветке до него): его
 * пропустила сверка конфликта, когда он начинался. Взять сторону целевой для
 * файла посреди него (`git show origin/main:a > a`, `checkout origin/main --
 * a`) — разрешение конфликта, а не новый догон: журнал 24.10, D33 — такой шаг
 * посреди разрешённого панелью перебазирования получил MAIN_SYNC_UNKNOWN.
 */
export async function syncUnderway(
  cwd: string,
  base: string | undefined,
  run: GitRunner = runGit,
): Promise<boolean> {
  const operation = await operationUnderway(cwd, run);
  if (!operation) return false;
  const known = await run(
    cwd,
    ['merge-base', '--is-ancestor', operation.incoming, operation.before],
    20_000,
  );
  // Код 0 — приносимое уже было в ветке (`rebase -i` своей истории): не догон.
  if (known.code !== 1) return false;
  return inTarget(cwd, operation.incoming, base, run);
}
