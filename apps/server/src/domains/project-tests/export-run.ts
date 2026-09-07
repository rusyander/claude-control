import type { ProjectTestGroup, ProjectTestRunRecord } from '@agentdeck/contracts';
import { ProjectTestsNotFoundError, ProjectTestsError } from './files.ts';
import { readGroups } from './store.ts';
import { readRun } from './runs-store.ts';
import type { ExportedFile } from './export-cases.ts';

/**
 * Отчёт по ОДНОМУ прогону файлом — то, что отдают наружу.
 *
 * Историю прогонов панель показывает у себя, но вопрос «что показать тому, у
 * кого панели нет» этим не закрывается: приёмка, заказчик и соседняя команда
 * читают файл, а не чужой localhost. Поэтому здесь ровно то, что нужно на
 * стороне: чем гоняли, на какой ветке, что упало и что при этом видели.
 *
 * Форматов два и оба текстовые. Markdown читают глазами (и он же печатается в
 * PDF браузером), CSV открывают в Excel и сводят с чем угодно. Своего PDF
 * панель не рисует намеренно: это был бы третий генератор вёрстки ради одной
 * страницы.
 */

export type RunExportFormat = 'md' | 'csv';

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
  throw new ProjectTestsError(`Формат отчёта по прогону: md или csv.`);
}
