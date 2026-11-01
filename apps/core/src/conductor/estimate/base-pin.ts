/**
 * Строка `signal base-pin` (F-169): приколотая база каждого репозитория задачи — ссылка, от
 * которой её взяли (`origin/main`, `origin/<ветка MR>`), и sha. `task.created.repos[].baseRef`
 * несёт только sha (ревизию копий и проверок); ВЕТКУ базы на сервере — куда смотрит MR и что
 * публикатор подтягивает перед пушем — знает только эта строка.
 */

/** Приколотая база каждого репозитория: свежая или локальная, с причиной (F-169). */
export const BASE_PIN_SIGNAL = 'base-pin';

/** Текст строки: `<ссылка> <sha>` и, если есть, `: <заметка>`. */
export function basePinDetail(ref: string, sha: string, note: string | null): string {
  return [`${ref} ${sha}`, note].filter(Boolean).join(': ');
}

/** Ссылка и sha из текста строки; не та форма — `null` (ссылка git не содержит ни `:`, ни пробела). */
export function parseBasePin(detail: string): { ref: string; sha: string } | null {
  const head = detail.split(': ')[0] ?? '';
  const [ref, sha, extra] = head.split(' ');
  if (!ref || !sha || extra !== undefined) return null;
  return { ref, sha };
}
