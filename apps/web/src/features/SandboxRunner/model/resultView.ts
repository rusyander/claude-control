import type { ProbeResult } from '@entities/Sandbox';

/** Поток вывода хука, как его показывает строка результата. */
export interface OutputView {
  stream: 'stdout' | 'stderr';
  text: string;
  lines: number;
  /** Длинный вывод свёрнут: строка результата не должна растягиваться на весь экран. */
  collapsed: boolean;
}

/**
 * Порог сворачивания. Короткий ответ хука (строка лога, однострочный JSON)
 * читается сразу; простыня трассировки открывается по клику и не выталкивает
 * соседние прогоны из видимой области.
 */
export const COLLAPSE_LINES = 6;
export const COLLAPSE_CHARS = 400;

function outputView(stream: OutputView['stream'], raw: string): OutputView | undefined {
  // Хвостовой перевод строки печатает почти любая команда — показывать его
  // пустой строкой значит путать «вывода нет» и «вывод пустой».
  const text = raw.replace(/\s+$/, '');
  if (!text.trim()) return undefined;
  const lines = text.split(/\r?\n/).length;
  return {
    stream,
    text,
    lines,
    collapsed: lines > COLLAPSE_LINES || text.length > COLLAPSE_CHARS,
  };
}

/**
 * Что показать под заголовком прогона — то, что увидит Claude Code: вывод и
 * код выхода. Раньше успешный прогон показывал только «пропустил» и время,
 * хотя сервер получал от процесса и stdout, и код — человек не видел, что хук
 * на самом деле ответил.
 *
 * Код выхода не показывается, когда процесса не было или он не завершился
 * сам: при несостоявшемся запуске сервер пишет -1, а у остановленного по
 * таймауту кода нет вовсе — ноль там был бы выдумкой.
 */
export function resultView(result: ProbeResult): {
  exitCode: number | undefined;
  outputs: OutputView[];
} {
  const exitCode = result.timedOut || result.exitCode < 0 ? undefined : result.exitCode;
  const outputs = [outputView('stdout', result.stdout), outputView('stderr', result.stderr)].filter(
    (view): view is OutputView => view !== undefined,
  );
  return { exitCode, outputs };
}
