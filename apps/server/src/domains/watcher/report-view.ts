import { existsSync, statSync } from 'node:fs';
import type { WatchReportSection, WatchReportView } from '@agentdeck/contracts';
import { readTextFile } from '../../lib/safe-io/safe-io.ts';
import { sectionsOf } from './report.ts';
import { REPORT_TEXTS } from './report-texts.ts';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/**
 * Строки списка-шапки раздела, которые страница уже рисует из меток: важность,
 * статус, место, повторы с датами, отпечаток. В теле они повторяли бы карточку
 * сырыми ISO-датами. Подписи — обоих языков: раздел мог быть записан до смены
 * языка. Тип с источником, запрос, длительность, страница и влитые остаются —
 * их на карточке нет.
 */
const CARD_LINE = new RegExp(
  `^- \\*\\*(?:${Object.values(REPORT_TEXTS)
    .flatMap((t) => [t.importance, t.status, t.location, t.repeats, t.fingerprint])
    .join('|')}):\\*\\*.*\\n?`,
  'gm',
);

/**
 * Отчёт наблюдателя для страницы панели: разделы с метками и телом.
 *
 * Файл остаётся единственной правдой — страница читает тот же
 * `WATCH-REPORT.md`, что человек пересылает агенту, со всеми его припиской
 * вне меток. Тело раздела отдаётся Markdown как есть, без заголовка `## WR-n ·`:
 * номер и заголовок страница рисует сама из меток, как и строки шапки,
 * повторяющие метки (`CARD_LINE`). Порядок — важность, затем
 * номер: самое опасное сверху, как в оглавлении файла.
 */
export function reportView(path: string): WatchReportView {
  if (!existsSync(path)) return { path, exists: false, sections: [] };
  let text: string;
  let updatedAt: string | undefined;
  try {
    text = readTextFile(path);
    updatedAt = statSync(path).mtime.toISOString();
  } catch {
    return { path, exists: false, sections: [] };
  }
  return {
    path,
    exists: true,
    ...(updatedAt ? { updatedAt } : {}),
    sections: reportSections(text),
  };
}

/** Разделы текста отчёта с телами. Чистая функция — её и проверяют. */
function reportSections(text: string): WatchReportSection[] {
  const sections: WatchReportSection[] = [];
  for (const [id, meta] of sectionsOf(text)) {
    const open = text.search(new RegExp(`<!-- watch:${id} [^\\n]*-->`));
    const close = text.indexOf(`<!-- /watch:${id} -->`, open);
    const raw = text.slice(text.indexOf('\n', open) + 1, close < 0 ? undefined : close);
    const body = raw
      .replace(/^## [^\n]*\n/, '')
      .replace(CARD_LINE, '')
      .trim();
    sections.push({ id, ...meta, body });
  }
  return sections.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || refOrder(a.ref) - refOrder(b.ref),
  );
}

function refOrder(ref: string): number {
  const number = Number(/(\d+)$/.exec(ref)?.[1]);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}
