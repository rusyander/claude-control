import type { CheckRecord } from '@agentdeck/contracts/core/records';

/**
 * Сверка путей тестов из вывода раннера (A1r2-F03, B1-F05). Раннер печатает файл от СВОЕГО корня
 * (cwd проверки, корень пакета), на Windows — с `\`; изменённые пути и карантин — от корня репо.
 * Сравнение строкой называло изменённый тест «вне изменения». Здесь — без диска: прямые слэши,
 * без `./`, регистр свёрнут, совпадение по хвосту из целых сегментов.
 */

type Named = CheckRecord['failing'][number];

function norm(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .toLowerCase();
}

/** Абсолютная форма (POSIX или с буквой диска): корень неизвестен — к пути репо не сводится. */
export function isAbsoluteForm(path: string): boolean {
  return /^([a-zA-Z]:)?[\\/]/.test(path);
}

/** Один и тот же файл в двух формах: равны или один — хвост другого по границе сегмента. */
export function sameFileTail(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/** Файл не назван хоть с одной стороны — решает имя; назван с обеих — должен совпасть. */
export function sameTest(a: Named, b: Named): boolean {
  if (a.name !== b.name) return false;
  return a.file === undefined || b.file === undefined || sameFileTail(a.file, b.file);
}
