import type { ProjectTestGroup, ProjectTestRunRecord } from '@agentdeck/contracts';
import { runOrigin } from '@agentdeck/contracts/test-format';
import { ProjectTestsNotFoundError, ProjectTestsError } from './files.ts';
import { readGroups } from './store.ts';
import { readRun } from './runs-store.ts';
import { renderPdf } from './pdf.ts';
import type { ExportedFile } from './export-cases.ts';
import { coded } from '../../lib/server-text.ts';
import { csvCell } from '../../lib/csv-cell.ts';
import { reasonOf } from './point-reason.ts';
import { RUN_TEXTS, type ExportLanguage } from './export-run-texts.ts';

export { reasonOf };
export { exportLanguage, type ExportLanguage } from './export-run-texts.ts';

/**
 * Отчёт по ОДНОМУ прогону файлом — то, что отдают наружу.
 *
 * Историю прогонов панель показывает у себя, но вопрос «что показать тому, у
 * кого панели нет» этим не закрывается: приёмка, заказчик и соседняя команда
 * читают файл, а не чужой localhost. Поэтому здесь ровно то, что нужно на
 * стороне: чем гоняли, на какой ветке, что упало и что при этом видели.
 *
 * Язык отчёта — язык интерфейса того, кто выгружает (`export-run-texts.ts`).
 *
 * Форматов четыре, и все — один и тот же отчёт. Markdown читают глазами и
 * кладут в MR, CSV открывают в Excel, HTML сверстан под ПЕЧАТЬ (A4, поля,
 * неразрываемые строки таблицы), а PDF из него печатает браузер машины
 * (`pdf.ts`). Своего движка вёрстки панель не заводит: страница одна, а
 * Chromium с печатью в PDF стоит у всех.
 */

export type RunExportFormat = 'md' | 'csv' | 'html';

/**
 * Подпись записи: чем был прогон. У импорта — ещё и откуда он: автотесты,
 * прогнанные панелью, и отчёт сборки иначе уходили наружу одним «импорт из CI»,
 * а читающему файл это разные вещи (своя машина против конвейера). Правило
 * происхождения одно на всех — `runOrigin`.
 */
export function runTitle(
  run: Pick<ProjectTestRunRecord, 'mode' | 'origin'>,
  lang: ExportLanguage = 'ru',
): string {
  const texts = RUN_TEXTS[lang];
  if (runOrigin(run) === 'e2e') return texts.panelAutotests;
  return texts.mode[run.mode] ?? run.mode;
}

/** Колонки, которые печатная таблица держит и пустыми: без них строка не читается. */
const KEPT_COLUMNS: ReadonlySet<number> = new Set([0, 1, 2, 3, 6]);

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

/**
 * Время для читающего отчёт: местное, с поясом. ISO с «Z» — чужое время, и
 * проход в 02:25 ночи по местному уходил наружу датой вчерашнего дня. Пояс —
 * машины панели: она локальная и однопользовательская, это пояс человека.
 */
export function humanTime(iso: string, offset = -new Date(iso).getTimezoneOffset()): string {
  const shifted = shiftedDate(iso, offset);
  if (!shifted) return iso;
  const date = `${two(shifted.getUTCDate())}.${two(shifted.getUTCMonth() + 1)}.${shifted.getUTCFullYear()}`;
  const clock = `${two(shifted.getUTCHours())}:${two(shifted.getUTCMinutes())}`;
  const size = Math.abs(offset);
  const minutes = size % 60 ? `:${two(size % 60)}` : '';
  return `${date} ${clock} (UTC${offset < 0 ? '-' : '+'}${Math.floor(size / 60)}${minutes})`;
}

/** Метка времени для имени файла — по тому же местному времени, что и в шапке. */
function fileStamp(iso: string): string {
  const shifted = shiftedDate(iso, -new Date(iso).getTimezoneOffset());
  if (!shifted) return iso.replace(/[^0-9]/g, '').slice(0, 12);
  return `${shifted.getUTCFullYear()}${two(shifted.getUTCMonth() + 1)}${two(shifted.getUTCDate())}${two(shifted.getUTCHours())}${two(shifted.getUTCMinutes())}`;
}

function shiftedDate(iso: string, offset: number): Date | undefined {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? undefined : new Date(time + offset * 60_000);
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Итог строкой. Непройденное по плану названо: «Завершить» при непройденных
 * кейсах пишет только отмеченное, и без этой части наружу уходило «всего 3,
 * провалов нет» при четырёх задуманных.
 */
function summaryText(run: ProjectTestRunRecord, lang: ExportLanguage): string {
  const texts = RUN_TEXTS[lang];
  const total = run.summary.total;
  const open = Math.max(0, (run.planned ?? total) - total);
  const unwalked = open > 0 ? texts.unwalkedTail(open, run.planned ?? total) : '';
  return texts.summaryLine(run.summary) + unwalked;
}

/** Непройденные проходы строками: название кейса, id и параметры прохода. */
function unwalkedLines(run: ProjectTestRunRecord): string[] {
  return (run.unwalked ?? []).map((point) => {
    const params = paramsText(point.params);
    return `${point.title} (${point.caseId}${params ? ` · ${params}` : ''})`;
  });
}

function seconds(durationMs?: number): string {
  return durationMs === undefined ? '' : String(Math.round(durationMs / 1000));
}

/** Строки результатов — общая основа таблицы и CSV. */
export function runRows(
  run: ProjectTestRunRecord,
  groups: ProjectTestGroup[],
  lang: ExportLanguage = 'ru',
): string[][] {
  const titles = titlesOf(groups);
  const status = RUN_TEXTS[lang].status;
  return run.results.map((result) => [
    titles.get(`${result.groupId}:${result.caseId}`) ?? result.caseId,
    result.caseId,
    result.groupId,
    status[result.status] ?? result.status,
    paramsText(result.params),
    seconds(result.durationMs),
    reasonOf(result, lang),
    (result.attachments ?? []).join(' '),
    (result.defects ?? []).join(' '),
  ]);
}

export function runToCsv(
  run: ProjectTestRunRecord,
  groups: ProjectTestGroup[],
  lang: ExportLanguage = 'ru',
): string {
  const texts = RUN_TEXTS[lang];
  // Непройденное по плану — строками со своим статусом: CSV читают таблицей, и
  // без них там было «всего 3» при четырёх задуманных (ревью z1 C25).
  const unwalked = (run.unwalked ?? []).map((point) => [
    point.title,
    point.caseId,
    point.groupId,
    texts.unwalked,
    paramsText(point.params),
    '',
    '',
    '',
    '',
  ]);
  // Шапки у CSV нет — чем был прогон, несёт последняя колонка каждой строки:
  // таблицу из двух выгрузок (панель и CI) иначе не развести после склейки.
  const title = runTitle(run, lang);
  const lines = [
    [...texts.columns, texts.recordColumn],
    ...[...runRows(run, groups, lang), ...unwalked].map((row) => [...row, title]),
  ].map((row) => row.map((cell) => csvCell(cell)).join(','));
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
export function runToMarkdown(
  run: ProjectTestRunRecord,
  groups: ProjectTestGroup[],
  lang: ExportLanguage = 'ru',
): string {
  const t = RUN_TEXTS[lang];
  const state = t.state[run.status];
  const head = [
    `# ${t.heading}: ${runTitle(run, lang)}`,
    '',
    `- ${t.started}: ${humanTime(run.startedAt)}`,
    `- ${t.finished}: ${run.finishedAt ? humanTime(run.finishedAt) : t.neverFinished}`,
    // Как в html: у завершённого своего слова в `state` нет — «завершён».
    `- ${t.stateLabel}: ${state ?? t.finishedState}`,
    `- ${t.actorLabel}: ${t.actor[run.actor] ?? run.actor}`,
    run.branch ? `- ${t.branch}: ${run.branch}` : undefined,
    run.commit ? `- ${t.commit}: ${run.commit.slice(0, 12)}` : undefined,
    run.environmentId ? `- ${t.environment}: ${run.environmentId}` : undefined,
    run.planId ? `- ${t.plan}: ${run.planId}` : undefined,
    run.tokens ? `- ${t.tokens}: ${run.tokens}` : undefined,
    run.error ? `- ${t.broke}: ${run.error}` : undefined,
    '',
    `**${t.summary}:** ${summaryText(run, lang)}`,
    '',
  ].filter((line) => line !== undefined);

  const titles = titlesOf(groups);
  const broken = run.results.filter(
    (result) => result.status === 'failed' || result.status === 'blocked',
  );
  const failures = broken.length
    ? [
        `## ${t.failedHeading}`,
        '',
        ...broken.map((result) => {
          const title = titles.get(`${result.groupId}:${result.caseId}`) ?? result.caseId;
          const reason = reasonOf(result, lang);
          const note = reason ? ` — ${reason}` : '';
          const files = (result.attachments ?? []).length
            ? ` (${t.attachments}: ${(result.attachments ?? []).join(', ')})`
            : '';
          return `- **${title}** [${t.status[result.status] ?? result.status}]${note}${files}`;
        }),
        '',
      ]
    : [`## ${t.failedHeading}`, '', t.noFailures, ''];

  const open = unwalkedLines(run);
  const unwalked = open.length
    ? [`## ${t.unwalkedHeading}`, '', ...open.map((line) => `- ${line}`), '']
    : [];

  const rows = runRows(run, groups, lang);
  const table = rows.length
    ? [
        `## ${t.passesHeading}`,
        '',
        `| ${t.columns.join(' | ')} |`,
        `| ${t.columns.map(() => '---').join(' | ')} |`,
        // Перевод строки в ячейке рвёт строку таблицы — в md он `<br>`.
        ...rows.map(
          (row) =>
            `| ${row.map((cell) => cell.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')).join(' | ')} |`,
        ),
        '',
      ]
    : [`## ${t.passesHeading}`, '', t.noResults, ''];

  return [...head, ...failures, ...unwalked, ...table].join('\n');
}

/** Экранирование для HTML: в заметках прогона бывает и `<`, и `&`. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Вёрстка печатной страницы — одна на все документы раздела.
 *
 * Стили внутри страницы и без единого внешнего файла: печатать её будет
 * браузер во временной папке, где ни шрифтов, ни картинок рядом нет, а
 * страница, ждущая сеть, печатается пустой. `@page` задаёт A4 и поля,
 * `break-inside: avoid` не даёт разорвать строку таблицы между листами —
 * без этого половина провала уезжает на следующую страницу.
 *
 * Принудительных разрывов (`break-before: page`) здесь нет намеренно: пустая
 * страница в PDF берётся именно из них — раздел кончился у края листа, а разрыв
 * добавил следующий. Заголовкам вместо этого запрещено оставаться последней
 * строкой листа (`break-after: avoid`).
 */
export const PRINT_CSS = `
  @page { size: A4; margin: 16mm 14mm; }
  body { font: 11pt/1.45 "Segoe UI", Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 18pt; margin: 0 0 4mm; }
  h2 { font-size: 13pt; margin: 6mm 0 2mm; break-after: avoid; }
  h1 + *, h2 + * { break-before: avoid; }
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
`;

/** Тот же отчёт, свёрстанный под печать (`PRINT_CSS`). */
export function runToHtml(
  run: ProjectTestRunRecord,
  groups: ProjectTestGroup[],
  lang: ExportLanguage = 'ru',
): string {
  const t = RUN_TEXTS[lang];
  const titles = titlesOf(groups);
  const broken = run.results.filter(
    (result) => result.status === 'failed' || result.status === 'blocked',
  );
  const facts = [
    [t.started, humanTime(run.startedAt)],
    [t.finished, run.finishedAt ? humanTime(run.finishedAt) : t.neverFinished],
    [t.stateLabel, t.state[run.status] ?? t.finishedState],
    [t.actorLabel, t.actor[run.actor] ?? run.actor],
    [t.branch, run.branch ?? '—'],
    [t.commit, run.commit ? run.commit.slice(0, 12) : '—'],
    [t.environment, run.environmentId ?? '—'],
    [t.plan, run.planId ?? '—'],
  ];

  // Лист узкий: колонка, пустая во всех строках, только отнимает ширину у
  // «Что увидели», и строки вырастают так, что уезжают на следующий лист.
  const allRows = runRows(run, groups, lang);
  const shown = t.columns
    .map((_, index) => index)
    .filter((index) => KEPT_COLUMNS.has(index) || allRows.some((row) => row[index]));
  const columns = shown.map((index) => t.columns[index] ?? '');
  const rows = allRows
    .map(
      (row) =>
        `<tr>${shown.map((index) => `<td>${escapeHtml(row[index] ?? '')}</td>`).join('')}</tr>`,
    )
    .join('\n');

  const failures = broken.length
    ? broken
        .map((result) => {
          const title = titles.get(`${result.groupId}:${result.caseId}`) ?? result.caseId;
          const reason = reasonOf(result, lang);
          const note = reason ? ` — ${reason}` : '';
          return `<li><b>${escapeHtml(title)}</b> [${t.status[result.status] ?? result.status}]${escapeHtml(note)}</li>`;
        })
        .join('\n')
    : `<li>${t.noFailures}</li>`;

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${t.heading} ${escapeHtml(humanTime(run.startedAt))}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<h1>${t.heading}: ${escapeHtml(runTitle(run, lang))}</h1>
<dl>${facts.map(([name, value]) => `<dt>${name}</dt><dd>${escapeHtml(String(value))}</dd>`).join('')}</dl>
${run.error ? `<p class="error">${t.broke}: ${escapeHtml(run.error)}</p>` : ''}
<p class="summary"><b>${t.summary}:</b> ${escapeHtml(summaryText(run, lang))}</p>
<h2>${t.failedHeading}</h2>
<ul>
${failures}
</ul>
${
  unwalkedLines(run).length
    ? `<h2>${t.unwalkedHeading}</h2>
<ul>
${unwalkedLines(run)
  .map((line) => `<li>${escapeHtml(line)}</li>`)
  .join('\n')}
</ul>`
    : ''
}
<h2>${t.passesHeading}</h2>
${
  rows
    ? `<table><thead><tr>${columns.map((name) => `<th>${name}</th>`).join('')}</tr></thead><tbody>
${rows}
</tbody></table>`
    : `<p>${t.noResults}</p>`
}
</body>
</html>`;
}

/** Отчёт по прогону файлом. Прогон ищется и по имени файла, и по своему id. */
export function exportRun(
  root: string,
  runId: string,
  format: RunExportFormat,
  lang: ExportLanguage = 'ru',
): ExportedFile {
  const run = readRun(root, runId);
  if (!run)
    throw coded(
      new ProjectTestsNotFoundError(`Прогон «${runId}» не найден.`),
      'publish-run-not-found',
      { runId },
    );

  const groups = readGroups(root).filter((group) => !group.error);
  const stamp = fileStamp(run.startedAt);

  if (format === 'md') {
    return {
      filename: `run-${stamp}.md`,
      contentType: 'text/markdown; charset=utf-8',
      body: Buffer.from(runToMarkdown(run, groups, lang), 'utf8'),
    };
  }
  if (format === 'csv') {
    return {
      filename: `run-${stamp}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: Buffer.from(runToCsv(run, groups, lang), 'utf8'),
    };
  }
  if (format === 'html') {
    return {
      filename: `run-${stamp}.html`,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(runToHtml(run, groups, lang), 'utf8'),
    };
  }
  throw new ProjectTestsError(`Формат отчёта по прогону: md, csv или html.`);
}

/**
 * Тот же отчёт в PDF. Печатает браузер машины; браузера нет — 501 с именем
 * того, что поставить (`pdf.ts`), а не пустой файл.
 */
export async function exportRunPdf(
  root: string,
  runId: string,
  lang: ExportLanguage = 'ru',
): Promise<ExportedFile> {
  const html = exportRun(root, runId, 'html', lang);
  return {
    filename: html.filename.replace(/\.html$/, '.pdf'),
    contentType: 'application/pdf',
    body: await renderPdf(html.body.toString('utf8')),
  };
}
