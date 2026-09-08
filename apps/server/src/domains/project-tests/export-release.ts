import type {
  ProjectTestReleaseCase,
  ProjectTestReleaseDefect,
  ProjectTestReleaseDocument,
  ProjectTestReleaseRequirement,
} from '@agentdeck/contracts';
import { ProjectTestsError } from './files.ts';
import type { ExportedFile } from './export-cases.ts';
import { PRINT_CSS, escapeHtml } from './export-run.ts';
import { renderPdf } from './pdf.ts';

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
 */

export type ReleaseExportFormat = 'md' | 'html';

const STATE_TEXT: Record<ProjectTestReleaseRequirement['state'], string> = {
  uncovered: 'не покрыто',
  red: 'провал',
  partial: 'не проверено до конца',
  covered: 'закрыто',
};

const STATUS_TEXT: Record<string, string> = {
  passed: 'пройден',
  failed: 'провален',
  skipped: 'пропущен',
  blocked: 'заблокирован',
  unknown: 'не проверялся',
};

const DEFECT_STATE_TEXT: Record<string, string> = {
  open: 'открыт',
  unknown: 'статус не спрашивали',
  closed: 'закрыт',
};

const MODE_TEXT: Record<string, string> = {
  run: 'прогон агентом',
  generate: 'генерация',
  explore: 'исследование',
  automate: 'автоматизация',
  manual: 'ручной проход',
  import: 'импорт из CI',
};

const PRIORITY_TEXT: Record<string, string> = {
  blocker: 'блокер',
  high: 'высокая',
  medium: 'средняя',
  low: 'низкая',
};

/**
 * Дата по-человечески, во времени той машины, что печатает.
 *
 * Документ уходит приёмке и заказчику, а `2026-09-08T07:49:59.037Z` читается
 * там как след разработки: и час чужой, и миллисекунды никому не нужны.
 */
function stamp(value: string | undefined): string {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const two = (number: number): string => String(number).padStart(2, '0');
  return `${two(at.getDate())}.${two(at.getMonth() + 1)}.${at.getFullYear()} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/**
 * Имя кейса с важностью: без неё список провалов читается как ровный шум.
 *
 * Статус приписывается только там, где он разный (провалы: `failed` и
 * `blocked` чинят по-разному). В списке непроверенного он у всех один, и
 * повторять его строкой значит гнать глаз по одинаковому хвосту.
 */
function caseLine(item: ProjectTestReleaseCase, withStatus = false): string {
  const priority = item.priority ? ` [${PRIORITY_TEXT[item.priority] ?? item.priority}]` : '';
  const status = withStatus ? ` — ${STATUS_TEXT[item.status] ?? item.status}` : '';
  const note = item.note ? ` — ${item.note}` : '';
  return `${item.title}${priority}${status}${note}`;
}

function defectLine(item: ProjectTestReleaseDefect): string {
  const name = item.title ?? item.key ?? item.url;
  const state = item.stateLabel ?? DEFECT_STATE_TEXT[item.state] ?? item.state;
  return `${name} (${state}) — ${item.caseTitle}: ${item.url}`;
}

function requirementCells(item: ProjectTestReleaseRequirement): string[] {
  return [
    item.key,
    item.title ?? '',
    String(item.cases),
    String(item.passed),
    String(item.failed),
    String(item.untested),
    STATE_TEXT[item.state],
  ];
}

const REQUIREMENT_COLUMNS = [
  'Ключ',
  'Требование',
  'Кейсов',
  'Пройдено',
  'Провалов',
  'Не проверено',
  'Состояние',
];

const RUN_COLUMNS = ['Начат', 'Чем', 'Кто', 'Ветка', 'Пройдено', 'Провалено', 'Пропущено'];

function runCells(item: ProjectTestReleaseDocument['runs'][number]): string[] {
  return [
    stamp(item.startedAt),
    MODE_TEXT[item.mode] ?? item.mode,
    item.actor,
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
export function releaseToMarkdown(doc: ProjectTestReleaseDocument): string {
  const lines: string[] = [
    `# Готовность вехи «${doc.release}»`,
    '',
    `- Собран: ${stamp(doc.generatedAt)}`,
    doc.branch ? `- Ветка: ${doc.branch}` : undefined,
    doc.commit ? `- Коммит: ${doc.commit.slice(0, 12)}` : undefined,
    `- Прогонов вехи: ${doc.totals.runs}`,
    '',
    `**Вердикт:** ${doc.verdict.text}`,
    '',
    `Кейсов ${doc.totals.cases} · пройдено ${doc.totals.passed} · провалено ${doc.totals.failed} · ` +
      `заблокировано ${doc.totals.blocked} · пропущено ${doc.totals.skipped} · ` +
      `не проверено ${doc.totals.untested} · в карантине ${doc.totals.muted}`,
    '',
    '## Что мешает',
    '',
  ].filter((line): line is string => line !== undefined);

  lines.push(`### Не проверено (${doc.untested.length})`, '');
  lines.push(
    ...(doc.untested.length
      ? doc.untested.map((item) => `- ${caseLine(item)}`)
      : ['Непроверенных кейсов нет.']),
    '',
  );

  lines.push(`### Незакрытые дефекты (${doc.defects.length})`, '');
  lines.push(
    ...(doc.defects.length
      ? doc.defects.map((item) => `- ${defectLine(item)}`)
      : ['Незакрытых дефектов нет.']),
    '',
  );

  lines.push(`### Провалы (${doc.red.length})`, '');
  lines.push(
    ...(doc.red.length ? doc.red.map((item) => `- ${caseLine(item, true)}`) : ['Провалов нет.']),
    '',
  );

  if (doc.muted.length) {
    lines.push(`### В карантине (${doc.muted.length})`, '');
    lines.push(
      ...doc.muted.map(
        (item) => `- ${caseLine(item)}${item.muteReason ? ` · ${item.muteReason}` : ''}`,
      ),
      '',
    );
  }

  lines.push('## Требования', '');
  if (doc.warning) lines.push(`_${doc.warning}_`, '');
  if (doc.requirements.length) {
    lines.push(
      `| ${REQUIREMENT_COLUMNS.join(' | ')} |`,
      `| ${REQUIREMENT_COLUMNS.map(() => '---').join(' | ')} |`,
      ...doc.requirements.map(
        (item) =>
          `| ${requirementCells(item)
            .map((cell) => cell.replace(/\|/g, '\\|'))
            .join(' | ')} |`,
      ),
    );
  } else {
    lines.push('Требований в документе нет: кейсы ни на что не ссылаются, а трекер не спрошен.');
  }
  lines.push('');

  lines.push('## Прогоны вехи', '');
  if (doc.runs.length) {
    lines.push(
      `| ${RUN_COLUMNS.join(' | ')} |`,
      `| ${RUN_COLUMNS.map(() => '---').join(' | ')} |`,
      ...doc.runs.map((item) => `| ${runCells(item).join(' | ')} |`),
    );
  } else {
    lines.push('Прогонов с этой вехой в истории нет.');
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
export function releaseToHtml(doc: ProjectTestReleaseDocument): string {
  const facts = [
    ['Собран', stamp(doc.generatedAt)],
    ['Ветка', doc.branch ?? '—'],
    ['Коммит', doc.commit ? doc.commit.slice(0, 12) : '—'],
    ['Прогонов вехи', String(doc.totals.runs)],
  ];

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Готовность вехи ${escapeHtml(doc.release)}</title>
<style>${PRINT_CSS}
  .verdict { border: 1px solid #111; padding: 3mm; margin: 0 0 4mm; }
  .verdict.ready { border-color: #2a7; }
  .verdict.blocked { border-color: #a00; }
</style>
</head>
<body>
<h1>Готовность вехи «${escapeHtml(doc.release)}»</h1>
<dl>${facts.map(([name, value]) => `<dt>${name}</dt><dd>${escapeHtml(String(value))}</dd>`).join('')}</dl>
<p class="verdict ${doc.verdict.ready ? 'ready' : 'blocked'}"><b>Вердикт:</b> ${escapeHtml(doc.verdict.text)}</p>
<p class="summary">Кейсов ${doc.totals.cases} · пройдено ${doc.totals.passed} · провалено ${doc.totals.failed} · заблокировано ${doc.totals.blocked} · пропущено ${doc.totals.skipped} · не проверено ${doc.totals.untested} · в карантине ${doc.totals.muted}</p>
<h2>Не проверено (${doc.untested.length})</h2>
${list(
  doc.untested.map((item) => escapeHtml(caseLine(item))),
  'Непроверенных кейсов нет.',
)}
<h2>Незакрытые дефекты (${doc.defects.length})</h2>
${list(
  doc.defects.map((item) => escapeHtml(defectLine(item))),
  'Незакрытых дефектов нет.',
)}
<h2>Провалы (${doc.red.length})</h2>
${list(
  doc.red.map((item) => escapeHtml(caseLine(item, true))),
  'Провалов нет.',
)}
${
  doc.muted.length
    ? `<h2>В карантине (${doc.muted.length})</h2>
${list(
  doc.muted.map((item) =>
    escapeHtml(`${caseLine(item)}${item.muteReason ? ` · ${item.muteReason}` : ''}`),
  ),
  '',
)}`
    : ''
}
<h2>Требования</h2>
${doc.warning ? `<p class="error">${escapeHtml(doc.warning)}</p>` : ''}
${table(
  REQUIREMENT_COLUMNS,
  doc.requirements.map((item) => requirementCells(item)),
  'Требований в документе нет: кейсы ни на что не ссылаются, а трекер не спрошен.',
)}
<h2>Прогоны вехи</h2>
${table(
  RUN_COLUMNS,
  doc.runs.map((item) => runCells(item)),
  'Прогонов с этой вехой в истории нет.',
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
): ExportedFile {
  if (format === 'md') {
    return {
      filename: releaseFileName(doc.release, 'md'),
      contentType: 'text/markdown; charset=utf-8',
      body: Buffer.from(releaseToMarkdown(doc), 'utf8'),
    };
  }
  if (format === 'html') {
    return {
      filename: releaseFileName(doc.release, 'html'),
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(releaseToHtml(doc), 'utf8'),
    };
  }
  throw new ProjectTestsError('Формат документа готовности: md или html.');
}

/**
 * Тот же документ в PDF. Печатает браузер машины; браузера нет — 501 с именем
 * того, что поставить (`pdf.ts`), а не пустой файл.
 */
export async function exportReleasePdf(doc: ProjectTestReleaseDocument): Promise<ExportedFile> {
  return {
    filename: releaseFileName(doc.release, 'pdf'),
    contentType: 'application/pdf',
    body: await renderPdf(releaseToHtml(doc)),
  };
}
