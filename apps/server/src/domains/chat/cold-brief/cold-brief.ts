import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitSync } from '../../project-git/exec/exec.ts';
import { readTailRecords } from '../ChatTranscriptFile/ChatTranscriptFile.ts';
import { textOf } from '../ChatRecords/ChatRecords.ts';
import { lastAskedInputIn } from '../pending-asks/pending-asks.ts';
import { TASK_NOTEBOOK } from '../task-notebook/task-notebook.ts';
import { TASK_TICKETS } from '../task-tickets/task-tickets.ts';

/**
 * Факты для нового разговора вместо остывшего (рычаг `freshOnColdResume`).
 *
 * Собирает их ПАНЕЛЬ — из файлов копии и хвоста прежнего транскрипта. Просить
 * остывшую сессию пересказать себя нельзя: пересказ — это холодное чтение всего
 * окна плюс его переписывание, ровно та цена, которой избегаем. Просить новую
 * сессию собрать факты самой — десяток мелких вызовов на `git status`, `git log`
 * и заметки, каждый со всей базой в окне; собранные здесь, они стоят один раз.
 */

/** Сколько заметок группы едет в вводную: дальше — путь, модель дочитает сама. */
export const BRIEF_NOTEBOOK_CHARS = 4_000;
/** Последний ответ прежнего разговора — итог стадии, а не весь её ход. */
export const BRIEF_LAST_ANSWER_CHARS = 3_000;
const BRIEF_GIT_LINES = 40;

/**
 * Заметки группы в её копии — в порядке, в котором их стоит читать. Первыми —
 * блокнот и тикеты, которые панель велит группе вести (`GROUP_ECONOMY_PROMPT`):
 * там решения стадий; без них новая сессия собирает их заново.
 */
const NOTEBOOK_FILES = [TASK_NOTEBOOK, TASK_TICKETS, '.agent/PROGRESS.md', '.agent/notes.md'];

/** Ветки, от которых считаются изменения группы: первая найденная — база. */
const BASE_REFS = ['origin/HEAD', 'origin/main', 'origin/master'];

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n…(cut at ${max} chars)` : trimmed;
}

// Только хвост: ведущий пробел у `git status --short` — смысл (« M» — правка
// не в индексе, «M » — в индексе), а у `--stat` — выравнивание колонок.
function clipLines(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.length > BRIEF_GIT_LINES
    ? [...lines.slice(0, BRIEF_GIT_LINES), `…(${lines.length - BRIEF_GIT_LINES} more lines)`].join(
        '\n',
      )
    : lines.join('\n');
}

/** Последний текст модели в транскрипте: итог прежней стадии. */
export function lastAnswer(transcript: string): string {
  const records = readTailRecords(transcript);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.type !== 'assistant') continue;
    const text = textOf(record);
    if (text.trim()) return text;
  }
  return '';
}

/**
 * Неотвеченный `AskUserQuestion` прежнего разговора — вопрос и варианты.
 * Ответ человека приходит новым ходом («Вариант A»), а вызов вопроса остался в
 * старой сессии: без него новая сессия не знает, на что ей ответили. Вопрос
 * текстом уже лежит в последнем ответе.
 */
function openQuestion(transcript: string): string {
  const input = lastAskedInputIn(transcript) as
    { questions?: { question?: unknown; options?: { label?: unknown }[] }[] } | undefined;
  const lines: string[] = [];
  for (const item of input?.questions ?? []) {
    if (typeof item.question !== 'string') continue;
    const labels = (item.options ?? [])
      .map((option) => option.label)
      .filter((label): label is string => typeof label === 'string');
    lines.push(`- ${item.question}${labels.length ? ` Options: ${labels.join(' | ')}` : ''}`);
  }
  return lines.join('\n');
}

function mergeBase(cwd: string, own?: string): { ref: string; sha: string } | undefined {
  // Копия от ветки предшественника (`base` группы с `after`) считает своё от неё:
  // от origin/HEAD в «коммиты группы» попали бы и его коммиты (F-25 ревью П1).
  const refs = own ? [own, `origin/${own}`, ...BASE_REFS] : BASE_REFS;
  for (const ref of refs) {
    const sha = gitSync(cwd, ['merge-base', 'HEAD', ref])?.trim();
    if (sha) return { ref, sha };
  }
  return undefined;
}

/**
 * Блок фактов для вводной: заметки, git от базы, незакоммиченное, последний
 * ответ и путь к прежнему транскрипту. Пустой раздел не печатается. `base` —
 * ветка, от которой отведена копия группы; нет — основная ветка origin.
 */
export function coldBriefFacts(cwd: string, transcript: string, base?: string): string {
  const parts: string[] = ['Facts the panel collected for you — do not collect them again:'];
  for (const rel of NOTEBOOK_FILES) {
    const file = join(cwd, rel);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.trim()) parts.push(`## Notebook ${rel}`, clip(text, BRIEF_NOTEBOOK_CHARS));
  }
  const branch = gitSync(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  const fork = mergeBase(cwd, base);
  const log = fork
    ? gitSync(cwd, ['log', '--oneline', '-n', '15', `${fork.sha}..HEAD`])
    : gitSync(cwd, ['log', '--oneline', '-n', '10']);
  if (log?.trim()) {
    parts.push(
      `## Commits on ${branch ?? 'HEAD'}${fork ? ` since ${fork.ref}` : ''}`,
      clipLines(log),
    );
  }
  const stat = fork ? gitSync(cwd, ['diff', '--stat', fork.sha]) : undefined;
  if (stat?.trim()) parts.push(`## Changed vs ${fork!.ref} (git diff --stat)`, clipLines(stat));
  const status = gitSync(cwd, ['status', '--short']);
  if (status !== undefined) {
    parts.push('## Uncommitted (git status --short)', status.trim() ? clipLines(status) : 'clean');
  }
  const answer = lastAnswer(transcript);
  if (answer) {
    parts.push(
      '## Your last answer in the previous conversation',
      clip(answer, BRIEF_LAST_ANSWER_CHARS),
    );
  }
  const asked = openQuestion(transcript);
  if (asked) {
    parts.push(
      '## Your question still open in the previous conversation (the message below may answer it)',
      clip(asked, BRIEF_LAST_ANSWER_CHARS),
    );
  }
  parts.push(
    `Previous transcript: ${transcript} — grep it for one missing detail; never read it whole.`,
  );
  return parts.join('\n');
}
