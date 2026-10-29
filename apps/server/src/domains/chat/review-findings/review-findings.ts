import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_DIR, ensureRunDir } from '../../../lib/run-dir/run-dir.ts';

/**
 * Находки ревью — файлом в копии (аудит g9 27.10, R7): перепроверка искала свои
 * R-1..R-3 по `.agent` и по старому транскрипту — 1,19 млн токенов на контексте
 * ~198 тыс. Карточки правок жили только в связи панели и в прошлом разговоре.
 * Теперь панель пишет их сюда с номерами: R-n — карточки звена правок, V-n — что
 * проход проверки оставил открытым. Файл ведёт панель, агент его не правит.
 */
export const REVIEW_FINDINGS = `${RUN_DIR}/review-findings.agent.md`;

/** Что записать: карточки звена правок или открытое после прохода проверки. */
type ReviewFindingsKind = 'fix' | 'open';

/** Заголовок карточки в оглавлении вводной — первая строка, не длиннее этого. */
const TITLE_MAX = 100;

const HEADER =
  '# Review findings — kept by the panel\n\n' +
  'Rewritten by the panel when a fix stage starts (R-n, the cards of that stage) and when a ' +
  'verification pass leaves points open (V-n). Cite a finding by its id in notes, answers and ' +
  'the MR description; after a compaction read this file instead of searching old ' +
  'conversations. Do not edit it.\n';

/** Начало раздела открытого: по нему новый проход проверки заменяет прежний раздел. */
const OPEN_MARK = '\n---\nOpen after verification';

const stamp = (at: string): string => `${at.slice(0, 16).replace('T', ' ')} UTC`;
const counted = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function titleOf(card: string): string {
  const first = card.trim().split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? '';
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
}

function cardsBlock(prefix: 'R' | 'V', findings: readonly string[]): string {
  return findings
    .map((card, index) => `## ${prefix}-${index + 1} · ${titleOf(card)}\n\n${card.trim()}\n`)
    .join('\n');
}

export interface ReviewFindingsInput {
  kind: ReviewFindingsKind;
  findings: readonly string[];
  /** Ветка копии — в строке раунда. */
  branch?: string;
  /** Момент записи (ISO); по умолчанию — сейчас. */
  at?: string;
}

/**
 * Записать файл и вернуть его путь от корня копии. Звено правок открывает новый
 * раунд — файл переписывается целиком; открытое после проверки заменяет только
 * свой раздел, карточки раунда остаются. Пустой список или сбой записи —
 * `undefined`, и задание звена о файле молчит. Запись — через временный файл:
 * группа может читать его в ту же секунду.
 */
export function writeReviewFindings(cwd: string, input: ReviewFindingsInput): string | undefined {
  // Нет каталога копии — нет и файла: `ensureRunDir` создал бы пустую копию-призрак
  // на месте удалённой (или по пути, которого не было).
  if (!cwd || input.findings.length === 0 || !existsSync(cwd)) return undefined;
  const at = stamp(input.at ?? new Date().toISOString());
  const where = input.branch ? `, branch ${input.branch}` : '';
  try {
    const dir = ensureRunDir(cwd);
    const file = join(cwd, REVIEW_FINDINGS);
    let text: string;
    if (input.kind === 'fix') {
      text =
        `${HEADER}\nFix stage — ${at}${where}; ${counted(input.findings.length, 'card')}.\n\n` +
        cardsBlock('R', input.findings);
    } else {
      const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const cut = previous.indexOf(OPEN_MARK);
      const head = (cut >= 0 ? previous.slice(0, cut) : previous).trimEnd() || HEADER.trimEnd();
      text =
        `${head}\n${OPEN_MARK} — ${at}${where}; ${counted(input.findings.length, 'point')}.\n\n` +
        cardsBlock('V', input.findings);
    }
    const temp = join(dir, `.review-findings-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(temp, text);
    renameSync(temp, file);
    return REVIEW_FINDINGS;
  } catch {
    return undefined;
  }
}
