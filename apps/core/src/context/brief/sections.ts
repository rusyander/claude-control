import type { ReconMap } from '@agentdeck/contracts/core/lead';
import { toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import type { BriefPart } from './brief.types.ts';
import type {
  FindingRef,
  HandoffInput,
  NotebookRef,
  PreviousAttemptRef,
} from './sections.types.ts';

/**
 * Секции брифа, что собирает ядро само (порт логики панели, панель не импортируется):
 * правила платформы — `panel-preamble` (строки, которые ядро вкладывает в каждый шаг), состояние
 * единицы для нового разговора — `cold-brief` + `task-notebook`, находки — `review-findings`
 * (номер и заголовок, тело в файле). Перемена секции посреди сессии уходит дельтой
 * (`context/sent`) — так же, как `workspace-note` панели морозил системную строку и слал перемену
 * сообщением хода: системная часть не меняется посреди разговора, кэш не переписывается.
 *
 * Каждая секция ссылается, а не вкладывает: длинное — путь и номер строки, с которой читать
 * (замер панели 25.10: обрезанная на 4k заметка перечитывалась целиком первым же вызовом).
 */

const FROM = 'context/brief';

/** Тетрадь до этого размера едет целиком; длиннее — начало по строкам и строка, с которой читать. */
export const NOTEBOOK_WHOLE_BYTES = 1200;
/** Файлов единицы в брифе; остальные — числом (полный список — `git diff` в копии). */
export const HANDOFF_FILES = 12;
/** Последних сделанных шагов в брифе. */
export const HANDOFF_STEPS = 5;
/** Находок списком; дальше — число и путь файла. */
export const FINDINGS_LISTED = 15;
const TITLE_MAX = 100;

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Правила, которые ядро вкладывает в шаг (секция `reminder`, корзина платформы): одни и те же
 * на всю сессию, поэтому дельта их второй раз не шлёт.
 */
export function platformRulesPart(stepKind: string, notebookPath?: string): BriefPart | null {
  const plan = toolPlanFor(stepKind);
  if (!plan) return null;
  const lines = [
    'Knowledge comes by reference: open the named paths yourself; nothing is inlined twice.',
  ];
  if (plan.builtins === 'read-only')
    lines.push('This step only reads: no file edits and no commands that change the copy.');
  if (plan.modelTools.includes('check'))
    lines.push('Run checks through the check tool, never by hand; cite its record ids.');
  if (notebookPath)
    lines.push(
      `Facts you had to find out: one line each in ${notebookPath} (Edit, never a secret); read it before searching again.`,
    );
  return { id: 'reminder', text: lines.join('\n'), from: FROM };
}

/** Тетрадь: целиком, пока коротка; иначе начало по целым строкам и строка, с которой читать. */
function notebookLines(notebook: NotebookRef): string[] {
  if (notebook.text === null) return [`Task notebook: ${notebook.path} (not read; open it).`];
  const text = notebook.text.trim();
  if (text === '') return [];
  if (bytesOf(text) <= NOTEBOOK_WHOLE_BYTES) return [`Task notebook ${notebook.path}:`, text];
  const kept: string[] = [];
  let used = 0;
  const all = text.split(/\r?\n/);
  for (const line of all) {
    const size = bytesOf(line) + 1;
    if (used + size > NOTEBOOK_WHOLE_BYTES) break;
    kept.push(line);
    used += size;
  }
  return [
    `Task notebook ${notebook.path} (first ${kept.length} of ${all.length} lines):`,
    ...kept,
    `Read the rest of ${notebook.path} from line ${kept.length + 1}.`,
  ];
}

/** Состояние единицы для нового разговора: шаги, изменённые файлы, тетрадь. */
export function handoffPart(input: HandoffInput): BriefPart | null {
  const lines: string[] = [];
  const steps = input.doneSteps.slice(-HANDOFF_STEPS);
  if (steps.length > 0) {
    const earlier = input.doneSteps.length - steps.length;
    lines.push(
      `Steps behind this one${earlier > 0 ? ` (last ${steps.length} of ${input.doneSteps.length})` : ''}:`,
    );
    for (const s of steps) lines.push(`- ${s.title} (${s.kind}): ${s.outcome}`);
  }
  if (input.changedFiles.length > 0) {
    const shown = input.changedFiles.slice(0, HANDOFF_FILES);
    lines.push(`Changed in this unit (${input.changedFiles.length}): ${shown.join(', ')}`);
    const more = input.changedFiles.length - shown.length;
    if (more > 0) lines.push(`+${more} more: git diff against the unit base in the copy.`);
  }
  if (input.notebook) lines.push(...notebookLines(input.notebook));
  return lines.length > 0 ? { id: 'handoff', text: lines.join('\n'), from: FROM } : null;
}

const titleOf = (title: string): string => {
  const first = title.trim().split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? '';
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
};

/** Байты текста карты разведки в брифе (корзина `recon` 3k минус заголовок и запас). */
export const RECON_BRIEF_BYTES = 2600;
/** Файлов карты в брифе; остальные — числом. */
export const RECON_FILES_LISTED = 10;
/** Предел секции прошлой попытки. */
export const PREVIOUS_ATTEMPT_BYTES = 600;

/**
 * Карта разведки для шага плана (W2-7, P136): строки карты целиком, файлы — путь и причина (не
 * больше `RECON_FILES_LISTED`), тесты и владельцы — числом и первыми именами. Тел файлов здесь нет
 * никогда: карта — указатель, модель открывает файлы сама. Строки сверх бюджета выпадают ЦЕЛИКОМ, и
 * секция говорит, сколько их не показано (не обрезка посреди строки, 03:136).
 */
export function reconMapPart(map: ReconMap, stepId: string): BriefPart | null {
  const wanted: string[] = [`Recon map (step ${stepId}):`, ...map.lines.map((l) => `- ${l}`)];
  if (map.files.length > 0) {
    wanted.push(`Files (${map.files.length}):`);
    for (const f of map.files.slice(0, RECON_FILES_LISTED)) wanted.push(`- ${f.path}: ${f.why}`);
    const more = map.files.length - RECON_FILES_LISTED;
    if (more > 0) wanted.push(`+${more} more files in the recon step record.`);
  }
  if (map.tests.length > 0) wanted.push(`Tests (${map.tests.length}): ${map.tests.join(', ')}`);
  if (map.owners.length > 0) wanted.push(`Owners: ${map.owners.join(', ')}`);
  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const line of wanted) {
    const size = bytesOf(line) + 1;
    if (omitted > 0 || used + size > RECON_BRIEF_BYTES) {
      omitted++;
      continue;
    }
    kept.push(line);
    used += size;
  }
  if (kept.length <= 1) return null;
  if (omitted > 0) kept.push(`(${omitted} more map lines omitted: read the recon step record.)`);
  return { id: 'recon-map', text: kept.join('\n'), from: FROM };
}

/**
 * Чем кончилась прошлая попытка шага (W2-10): запись провала — по id, причина — одной строкой.
 * Пересказа провала нет: модель открывает запись сама, а бриф остаётся в 600 байтах.
 */
export function previousAttemptPart(ref: PreviousAttemptRef): BriefPart | null {
  const why = ref.why.replace(/\s+/g, ' ').trim();
  if (why === '' && ref.recordId === null) return null;
  const head = [
    `Previous attempt of step ${ref.stepId} failed`,
    ref.recordId ? ` (record ${ref.recordId})` : '',
    ref.tier ? `; now running at tier ${ref.tier}` : '',
    '.',
  ].join('');
  // Запас — ровно то, что ляжет вокруг причины: «\nWhy: » и многоточие обрезки (3 байта UTF-8).
  const room = PREVIOUS_ATTEMPT_BYTES - bytesOf(head) - bytesOf('\nWhy: …');
  // Режем по кодовым точкам, а не по единицам UTF-16: срез посреди суррогатной пары оставил бы
  // одинокую половину, и в бриф ушёл бы «�» вместо символа.
  let reason = '';
  let used = 0;
  for (const ch of why) {
    const size = bytesOf(ch);
    if (used + size > room) break;
    reason += ch;
    used += size;
  }
  if (reason !== why) reason = `${reason.trimEnd()}…`;
  const text = reason === '' ? head : `${head}\nWhy: ${reason}`;
  return { id: 'previous-attempt', text, from: FROM };
}

/** Открытые находки: номер и заголовок; тело — в файле находок копии. */
export function findingsPart(findings: readonly FindingRef[], file: string): BriefPart | null {
  if (findings.length === 0) return null;
  const shown = findings.slice(0, FINDINGS_LISTED);
  const lines = [
    `Open findings (${findings.length}); full text in ${file}:`,
    ...shown.map((f) => `- ${f.id} · ${titleOf(f.title)}`),
  ];
  const more = findings.length - shown.length;
  if (more > 0) lines.push(`+${more} more in ${file}.`);
  return { id: 'findings', text: lines.join('\n'), from: FROM };
}
