import type {
  ProjectTestReleaseCase,
  ProjectTestReleaseDefect,
  ProjectTestReleaseDocument,
  ProjectTestReleaseRequirement,
} from '@agentdeck/contracts';
import { ProjectTestsError } from './files.ts';
import type { ExportedFile } from './export-cases.ts';
import { PRINT_CSS, escapeHtml, humanTime } from './export-run.ts';
import { renderPdf } from './pdf.ts';
import { RELEASE_TEXTS, type ReleaseTexts } from './export-release-texts.ts';
import type { ExportLanguage } from './export-run-texts.ts';
import { coded } from '../../lib/server-text.ts';

/**
 * Документ готовности вехи файлом — то, что уходит туда, где панели нет.
 *
 * Форматы те же, что у отчёта по прогону, и печатается он тем же путём: HTML
 * свёрстан под печать (`PRINT_CSS`), а PDF из него делает браузер машины
 * (`pdf.ts`). Своей вёрстки документ не заводит — иначе два отчёта раздела
 * разошлись бы по полям и шрифтам в первый же месяц.
 *
 * Порядок разделов задан домом (`release.ts`) и здесь не меняется: сначала то,
 * что мешает отдавать, потом чем закрыты требования, потом доказательства.
 *
 * Язык документа — язык интерфейса того, кто выгружает, как у отчёта по
 * прогону; слова живут парой в `export-release-texts.ts`.
 */

export type ReleaseExportFormat = 'md' | 'html';

/**
 * Дата по-человечески — как в отчёте прогона: местное время с поясом (`humanTime`).
 *
 * Документ уходит приёмке и заказчику, а `2026-09-08T07:49:59.037Z` читается
 * там как след разработки: и час чужой, и миллисекунды никому не нужны.
 */
function stamp(value: string | undefined): string {
  return value ? humanTime(value) : '—';
}

/**
 * Имя кейса с важностью: без неё список провалов читается как ровный шум.
 *
 * Статус приписывается только там, где он разный (провалы: `failed` и
 * `blocked` чинят по-разному). В списке непроверенного он у всех один, и
 * повторять его строкой значит гнать глаз по одинаковому хвосту.
 */
function caseLine(t: ReleaseTexts, item: ProjectTestReleaseCase, withStatus = false): string {
  const priority = item.priority ? ` [${t.priority[item.priority] ?? item.priority}]` : '';
  const status = withStatus ? ` — ${t.status[item.status] ?? item.status}` : '';
  const note = item.note ? ` — ${item.note}` : '';
  return `${item.title}${priority}${status}${note}`;
}

function defectLine(t: ReleaseTexts, item: ProjectTestReleaseDefect): string {
  const name = item.title ?? item.key ?? item.url;
  const state = item.stateLabel ?? t.defectState[item.state] ?? item.state;
  return `${name} (${state}) — ${item.caseTitle}: ${item.url}`;
}

function requirementCells(t: ReleaseTexts, item: ProjectTestReleaseRequirement): string[] {
  return [
    item.key,
    item.title ?? '',
    String(item.cases),
    String(item.passed),
    String(item.failed),
    String(item.untested),
    t.state[item.state],
  ];
}

function runCells(t: ReleaseTexts, item: ProjectTestReleaseDocument['runs'][number]): string[] {
  return [
    stamp(item.startedAt),
    t.mode[item.mode] ?? item.mode,
    t.actor[item.actor] ?? item.actor,
    item.branch ?? item.environmentId ?? '',
    String(item.summary.passed),
    String(item.summary.failed),
    String(item.summary.skipped + item.summary.blocked),
  ];
}

/**
 * Документ в markdown.
 *
 * Пустой раздел печатается строкой «нет», а не выбрасывается: отсутствие
 * непроверенного — это ответ, и молчание на его месте читается как «забыли
 * посчитать».
 */
export function releaseToMarkdown(
  doc: ProjectTestReleaseDocument,
  lang: ExportLanguage = 'ru',
): string {
  const t = RELEASE_TEXTS[lang];
  const warning = t.warning(doc);
  const lines: string[] = [
    `# ${t.heading(doc.release)}`,
    '',
    `- ${t.generated}: ${stamp(doc.generatedAt)}`,
    doc.branch ? `- ${t.branch}: ${doc.branch}` : undefined,
    doc.commit ? `- ${t.commit}: ${doc.commit.slice(0, 12)}` : undefined,
    `- ${t.runsCount}: ${doc.totals.runs}`,
    '',
    `**${t.verdictLabel}:** ${t.verdict(doc)}`,
    '',
    t.totalsLine(doc.totals),
    '',
    `## ${t.blocking}`,
    '',
  ].filter((line): line is string => line !== undefined);

  lines.push(`### ${t.untested} (${doc.untested.length})`, '');
  lines.push(
    ...(doc.untested.length
      ? doc.untested.map((item) => `- ${caseLine(t, item)}`)
      : [t.noUntested]),
    '',
  );

  lines.push(`### ${t.defects} (${doc.defects.length})`, '');
  lines.push(
    ...(doc.defects.length ? doc.defects.map((item) => `- ${defectLine(t, item)}`) : [t.noDefects]),
    '',
  );

  lines.push(`### ${t.red} (${doc.red.length})`, '');
  lines.push(
    ...(doc.red.length ? doc.red.map((item) => `- ${caseLine(t, item, true)}`) : [t.noRed]),
    '',
  );

  if (doc.muted.length) {
    lines.push(`### ${t.muted} (${doc.muted.length})`, '');
    lines.push(
      ...doc.muted.map(
        (item) => `- ${caseLine(t, item)}${item.muteReason ? ` · ${item.muteReason}` : ''}`,
      ),
      '',
    );
  }

  lines.push(`## ${t.requirements}`, '');
  if (warning) lines.push(`_${warning}_`, '');
  if (doc.requirements.length) {
    lines.push(
      `| ${t.requirementColumns.join(' | ')} |`,
      `| ${t.requirementColumns.map(() => '---').join(' | ')} |`,
      ...doc.requirements.map(
        (item) =>
          `| ${requirementCells(t, item)
            .map((cell) => cell.replace(/\|/g, '\\|'))
            .join(' | ')} |`,
      ),
    );
  } else {
    lines.push(t.noRequirements);
  }
  lines.push('');

  lines.push(`## ${t.runs}`, '');
  if (doc.runs.length) {
    lines.push(
      `| ${t.runColumns.join(' | ')} |`,
      `| ${t.runColumns.map(() => '---').join(' | ')} |`,
      ...doc.runs.map((item) => `| ${runCells(t, item).join(' | ')} |`),
    );
  } else {
    lines.push(t.noRuns);
  }
  lines.push('');

  return lines.join('\n');
}

function list(items: string[], empty: string): string {
  const rows = items.length ? items : [empty];
  return `<ul>${rows.map((row) => `<li>${row}</li>`).join('')}</ul>`;
}

function table(columns: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p>${escapeHtml(empty)}</p>`;
  const head = columns.map((name) => `<th>${name}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

/**
 * Тот же документ под печать.
 *
 * Вердикт стоит первым и рамкой: это единственная строка, ради которой документ
 * распечатывают, и искать её в середине третьей страницы никто не станет.
 */
export function releaseToHtml(
  doc: ProjectTestReleaseDocument,
  lang: ExportLanguage = 'ru',
): string {
  const t = RELEASE_TEXTS[lang];
  const warning = t.warning(doc);
  const facts = [
    [t.generated, stamp(doc.generatedAt)],
    [t.branch, doc.branch ?? '—'],
    [t.commit, doc.commit ? doc.commit.slice(0, 12) : '—'],
    [t.runsCount, String(doc.totals.runs)],
  ];

  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(t.pageTitle(doc.release))}</title>
<style>${PRINT_CSS}
  .verdict { border: 1px solid #111; padding: 3mm; margin: 0 0 4mm; }
  .verdict.ready { border-color: #2a7; }
  .verdict.blocked { border-color: #a00; }
</style>
</head>
<body>
<h1>${escapeHtml(t.heading(doc.release))}</h1>
<dl>${facts.map(([name, value]) => `<dt>${name}</dt><dd>${escapeHtml(String(value))}</dd>`).join('')}</dl>
<p class="verdict ${doc.verdict.ready ? 'ready' : 'blocked'}"><b>${t.verdictLabel}:</b> ${escapeHtml(t.verdict(doc))}</p>
<p class="summary">${t.totalsLine(doc.totals)}</p>
<h2>${t.untested} (${doc.untested.length})</h2>
${list(
  doc.untested.map((item) => escapeHtml(caseLine(t, item))),
  t.noUntested,
)}
<h2>${t.defects} (${doc.defects.length})</h2>
${list(
  doc.defects.map((item) => escapeHtml(defectLine(t, item))),
  t.noDefects,
)}
<h2>${t.red} (${doc.red.length})</h2>
${list(
  doc.red.map((item) => escapeHtml(caseLine(t, item, true))),
  t.noRed,
)}
${
  doc.muted.length
    ? `<h2>${t.muted} (${doc.muted.length})</h2>
${list(
  doc.muted.map((item) =>
    escapeHtml(`${caseLine(t, item)}${item.muteReason ? ` · ${item.muteReason}` : ''}`),
  ),
  '',
)}`
    : ''
}
<h2>${t.requirements}</h2>
${warning ? `<p class="error">${escapeHtml(warning)}</p>` : ''}
${table(
  t.requirementColumns,
  doc.requirements.map((item) => requirementCells(t, item)),
  t.noRequirements,
)}
<h2>${t.runs}</h2>
${table(
  t.runColumns,
  doc.runs.map((item) => runCells(t, item)),
  t.noRuns,
)}
</body>
</html>`;
}

/**
 * Имя файла: веха латиницей и цифрами.
 *
 * Кириллица и пробелы из имени вехи выбрасываются намеренно — имя уезжает в
 * заголовок `Content-Disposition`, где нелатинские байты ломают сохранение
 * молча: браузер отдаёт файл со случайным именем или не отдаёт вовсе.
 */
export function releaseFileName(release: string, extension: string): string {
  const slug = release
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `release-${slug || 'milestone'}.${extension}`;
}

export function exportRelease(
  doc: ProjectTestReleaseDocument,
  format: ReleaseExportFormat,
  lang: ExportLanguage = 'ru',
): ExportedFile {
  if (format === 'md') {
    return {
      filename: releaseFileName(doc.release, 'md'),
      contentType: 'text/markdown; charset=utf-8',
      body: Buffer.from(releaseToMarkdown(doc, lang), 'utf8'),
    };
  }
  if (format === 'html') {
    return {
      filename: releaseFileName(doc.release, 'html'),
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(releaseToHtml(doc, lang), 'utf8'),
    };
  }
  throw coded(new ProjectTestsError('Формат документа готовности: md или html.'), 'release-format');
}

/**
 * Тот же документ в PDF. Печатает браузер машины; браузера нет — 501 с именем
 * того, что поставить (`pdf.ts`), а не пустой файл.
 */
export async function exportReleasePdf(
  doc: ProjectTestReleaseDocument,
  lang: ExportLanguage = 'ru',
): Promise<ExportedFile> {
  return {
    filename: releaseFileName(doc.release, 'pdf'),
    contentType: 'application/pdf',
    body: await renderPdf(releaseToHtml(doc, lang)),
  };
}
