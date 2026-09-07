import type { ProjectTestGroup, ProjectTestRunRecord } from '@agentdeck/contracts';
import { ProjectTestsNotFoundError, ProjectTestsError } from './files.ts';
import { readGroups } from './store.ts';
import { readRun } from './runs-store.ts';
import { renderPdf } from './pdf.ts';
import type { ExportedFile } from './export-cases.ts';

/**
 * Отчёт по ОДНОМУ прогону файлом — то, что отдают наружу.
 *
 * Историю прогонов панель показывает у себя, но вопрос «что показать тому, у
 * кого панели нет» этим не закрывается: приёмка, заказчик и соседняя команда
 * читают файл, а не чужой localhost. Поэтому здесь ровно то, что нужно на
 * стороне: чем гоняли, на какой ветке, что упало и что при этом видели.
 *
 * Форматов четыре, и все — один и тот же отчёт. Markdown читают глазами и
 * кладут в MR, CSV открывают в Excel, HTML сверстан под ПЕЧАТЬ (A4, поля,
 * неразрываемые строки таблицы), а PDF из него печатает браузер машины
 * (`pdf.ts`). Своего движка вёрстки панель не заводит: страница одна, а
 * Chromium с печатью в PDF стоит у всех.
 */

export type RunExportFormat = 'md' | 'csv' | 'html';

const STATUS_TEXT: Record<string, string> = {
  passed: 'пройден',
  failed: 'провален',
  skipped: 'пропущен',
  blocked: 'заблокирован',
  unknown: 'не проверялся',
};

const MODE_TEXT: Record<string, string> = {
  run: 'прогон агентом',
  generate: 'генерация',
  explore: 'исследование',
  automate: 'автоматизация',
  manual: 'ручной проход',
  import: 'импорт из CI',
};

const ACTOR_TEXT: Record<string, string> = {
  agent: 'агент',
  human: 'человек',
  ci: 'CI',
};

const COLUMNS = [
  'Кейс',
  'ID',
  'Группа',
  'Статус',
  'Параметры',
  'Секунд',
  'Что увидели',
  'Вложения',
  'Дефекты',
];

function csvCell(value: string): string {
  return /["\n\r,;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function titlesOf(groups: ProjectTestGroup[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const group of groups) {
    for (const testCase of group.cases) titles.set(`${group.id}:${testCase.id}`, testCase.title);
  }
  return titles;
}

function paramsText(params?: Record<string, string>): string {
  return Object.entries(params ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join(' · ');
}

function seconds(durationMs?: number): string {
  return durationMs === undefined ? '' : String(Math.round(durationMs / 1000));
}

/** Строки результатов — общая основа таблицы и CSV. */
export function runRows(run: ProjectTestRunRecord, groups: ProjectTestGroup[]): string[][] {
  const titles = titlesOf(groups);
  return run.results.map((result) => [
    titles.get(`${result.groupId}:${result.caseId}`) ?? result.caseId,
    result.caseId,
    result.groupId,
    STATUS_TEXT[result.status] ?? result.status,
    paramsText(result.params),
    seconds(result.durationMs),
    result.note ?? '',
    (result.attachments ?? []).join(' '),
    (result.defects ?? []).join(' '),
  ]);
}

export function runToCsv(run: ProjectTestRunRecord, groups: ProjectTestGroup[]): string {
  const lines = [COLUMNS, ...runRows(run, groups)].map((row) =>
    row.map((cell) => csvCell(cell)).join(','),
  );
  // BOM — иначе Excel открывает кириллицу мусором.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * Документ прогона: шапка с обстоятельствами, отдельный список провалов, потом
 * всё остальное таблицей.
 *
 * Провалы вынесены наверх сознательно: отчёт открывают из-за них, а не ради
 * подтверждения, что сто кейсов зелёные.
 */
export function runToMarkdown(run: ProjectTestRunRecord, groups: ProjectTestGroup[]): string {
  const head = [
    `# Прогон: ${MODE_TEXT[run.mode] ?? run.mode}`,
    '',
    `- Начат: ${run.startedAt}`,
    run.finishedAt ? `- Завершён: ${run.finishedAt}` : '- Завершён: не завершался',
    `- Исполнитель: ${ACTOR_TEXT[run.actor] ?? run.actor}`,
    run.branch ? `- Ветка: ${run.branch}` : undefined,
    run.commit ? `- Коммит: ${run.commit.slice(0, 12)}` : undefined,
    run.environmentId ? `- Окружение: ${run.environmentId}` : undefined,
    run.planId ? `- План: ${run.planId}` : undefined,
    run.tokens ? `- Токенов: ${run.tokens}` : undefined,
    run.error ? `- Сорвался: ${run.error}` : undefined,
    '',
    `**Итог:** пройдено ${run.summary.passed} · провалено ${run.summary.failed} · ` +
      `пропущено ${run.summary.skipped} · заблокировано ${run.summary.blocked} ` +
      `(всего ${run.summary.total})`,
    '',
  ].filter((line) => line !== undefined);

  const titles = titlesOf(groups);
  const broken = run.results.filter(
    (result) => result.status === 'failed' || result.status === 'blocked',
  );
  const failures = broken.length
    ? [
        '## Что упало',
        '',
        ...broken.map((result) => {
          const title = titles.get(`${result.groupId}:${result.caseId}`) ?? result.caseId;
          const note = result.note ? ` — ${result.note}` : '';
          const files = (result.attachments ?? []).length
            ? ` (вложения: ${(result.attachments ?? []).join(', ')})`
            : '';
          return `- **${title}** [${STATUS_TEXT[result.status] ?? result.status}]${note}${files}`;
        }),
        '',
      ]
    : ['## Что упало', '', 'Провалов нет.', ''];

  const rows = runRows(run, groups);
  const table = rows.length
    ? [
        '## Проходы',
        '',
        `| ${COLUMNS.join(' | ')} |`,
        `| ${COLUMNS.map(() => '---').join(' | ')} |`,
        ...rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`),
        '',
      ]
    : ['## Проходы', '', 'Результатов в записи нет.', ''];

  return [...head, ...failures, ...table].join('\n');
}

/** Экранирование для HTML: в заметках прогона бывает и `<`, и `&`. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Тот же отчёт, свёрстанный под печать.
 *
 * Стили внутри страницы и без единого внешнего файла: печатать её будет
 * браузер во временной папке, где ни шрифтов, ни картинок рядом нет, а
 * страница, ждущая сеть, печатается пустой. `@page` задаёт A4 и поля,
 * `break-inside: avoid` не даёт разорвать строку таблицы между листами —
 * без этого половина провала уезжает на следующую страницу.
 */
export function runToHtml(run: ProjectTestRunRecord, groups: ProjectTestGroup[]): string {
  const titles = titlesOf(groups);
  const broken = run.results.filter(
    (result) => result.status === 'failed' || result.status === 'blocked',
  );
  const facts = [
    ['Начат', run.startedAt],
    ['Завершён', run.finishedAt ?? 'не завершался'],
    ['Исполнитель', ACTOR_TEXT[run.actor] ?? run.actor],
    ['Ветка', run.branch ?? '—'],
    ['Коммит', run.commit ? run.commit.slice(0, 12) : '—'],
    ['Окружение', run.environmentId ?? '—'],
    ['План', run.planId ?? '—'],
  ];

  const rows = runRows(run, groups)
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n');

  const failures = broken.length
    ? broken
        .map((result) => {
          const title = titles.get(`${result.groupId}:${result.caseId}`) ?? result.caseId;
          const note = result.note ? ` — ${result.note}` : '';
          return `<li><b>${escapeHtml(title)}</b> [${STATUS_TEXT[result.status] ?? result.status}]${escapeHtml(note)}</li>`;
        })
        .join('\n')
    : '<li>Провалов нет.</li>';

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Прогон ${escapeHtml(run.startedAt)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font: 11pt/1.45 "Segoe UI", Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 18pt; margin: 0 0 4mm; }
  h2 { font-size: 13pt; margin: 6mm 0 2mm; }
  dl { display: grid; grid-template-columns: 34mm 1fr; gap: 1mm 4mm; margin: 0 0 4mm; }
  dt { color: #555; }
  dd { margin: 0; }
  .summary { border: 1px solid #ccc; padding: 3mm; margin: 0 0 4mm; }
  ul { margin: 0; padding-left: 6mm; }
  li { break-inside: avoid; margin-bottom: 1.5mm; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  th, td { border: 1px solid #ccc; padding: 1.5mm 2mm; text-align: left; vertical-align: top; }
  th { background: #f3f3f3; }
  tr { break-inside: avoid; }
  .error { color: #a00; }
</style>
</head>
<body>
<h1>Прогон: ${escapeHtml(MODE_TEXT[run.mode] ?? run.mode)}</h1>
<dl>${facts.map(([name, value]) => `<dt>${name}</dt><dd>${escapeHtml(String(value))}</dd>`).join('')}</dl>
${run.error ? `<p class="error">Сорвался: ${escapeHtml(run.error)}</p>` : ''}
<p class="summary"><b>Итог:</b> пройдено ${run.summary.passed} · провалено ${run.summary.failed} · пропущено ${run.summary.skipped} · заблокировано ${run.summary.blocked} (всего ${run.summary.total})</p>
<h2>Что упало</h2>
<ul>
${failures}
</ul>
<h2>Проходы</h2>
${
  rows
    ? `<table><thead><tr>${COLUMNS.map((name) => `<th>${name}</th>`).join('')}</tr></thead><tbody>
${rows}
</tbody></table>`
    : '<p>Результатов в записи нет.</p>'
}
</body>
</html>`;
}

/** Отчёт по прогону файлом. Прогон ищется и по имени файла, и по своему id. */
export function exportRun(root: string, runId: string, format: RunExportFormat): ExportedFile {
  const run = readRun(root, runId);
  if (!run) throw new ProjectTestsNotFoundError(`Прогон «${runId}» не найден.`);

  const groups = readGroups(root).filter((group) => !group.error);
  const stamp = run.startedAt.replace(/[^0-9]/g, '').slice(0, 12);

  if (format === 'md') {
    return {
      filename: `run-${stamp}.md`,
      contentType: 'text/markdown; charset=utf-8',
      body: Buffer.from(runToMarkdown(run, groups), 'utf8'),
    };
  }
  if (format === 'csv') {
    return {
      filename: `run-${stamp}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: Buffer.from(runToCsv(run, groups), 'utf8'),
    };
  }
  if (format === 'html') {
    return {
      filename: `run-${stamp}.html`,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(runToHtml(run, groups), 'utf8'),
    };
  }
  throw new ProjectTestsError(`Формат отчёта по прогону: md, csv или html.`);
}

/**
 * Тот же отчёт в PDF. Печатает браузер машины; браузера нет — 501 с именем
 * того, что поставить (`pdf.ts`), а не пустой файл.
 */
export async function exportRunPdf(root: string, runId: string): Promise<ExportedFile> {
  const html = exportRun(root, runId, 'html');
  return {
    filename: html.filename.replace(/\.html$/, '.pdf'),
    contentType: 'application/pdf',
    body: await renderPdf(html.body.toString('utf8')),
  };
}
