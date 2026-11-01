import { createHash } from 'node:crypto';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { maskSink } from '../sinks/index.ts';
import type {
  PackFile,
  PackRecord,
  PackRequirement,
  ReviewPack,
  ReviewPackInput,
} from './review-pack.types.ts';

/**
 * Пакет ревью (03 §Context, порт `tools/review-pack.mjs` панели): дифф единицы против базы,
 * требования с вердиктами, сводка записей проверок — собран ядром один раз, ревьюер читает его
 * один раз (замер панели 16.10: шесть ревьюеров сделали 57 вызовов `git diff`, треть всего, что им
 * вернули инструменты). Дифф больше предела — пакет называет файлы списком, тело файла модель
 * берёт инструментом `unit_diff(file)`: срез посреди диффа ревьюер не отличил бы от конца.
 * Lock-файлы — имя и счёт строк без тела. Разговора автора во входе нет (тип), пакет — под маской
 * выхода `review-pack`.
 */

/** Тел диффа в пакете, байт (итог ревью 8k брифа + пакет — 03:136). */
export const REVIEW_PACK_CAP = 24_000;

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
]);

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8');
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const isLockfile = (path: string): boolean => LOCKFILES.has(baseName(path));

const stat = (f: PackFile): string =>
  f.binary ? `${f.path} (binary)` : `${f.path} +${f.added} -${f.deleted}`;

function filesBlock(files: readonly PackFile[], cap: number): { block: string; inline: boolean } {
  const bodies = files.filter((f) => f.diff !== null && !isLockfile(f.path));
  const size = bodies.reduce((sum, f) => sum + bytesOf(f.diff ?? ''), 0);
  const inline = size <= cap;
  const lines = [`## diff (${files.length} file(s))`];
  for (const f of files) {
    const note = isLockfile(f.path)
      ? ' — lock file, body left out'
      : f.diff === null
        ? ' — no git body (new untracked or binary): read the file in the copy'
        : '';
    lines.push(`- ${stat(f)}${note}`);
  }
  if (!inline)
    lines.push(
      `Diff bodies total ${size} bytes, over the pack cap of ${cap}: call unit_diff with {"file": "<path>"} for each file you review.`,
    );
  const block = inline
    ? [lines.join('\n'), ...bodies.map((f) => `### ${f.path}\n${f.diff ?? ''}`)].join('\n\n')
    : lines.join('\n');
  return { block, inline };
}

function requirementsBlock(requirements: readonly PackRequirement[]): string {
  const lines = ['## requirements'];
  if (requirements.length === 0) lines.push('(none extracted)');
  for (const r of [...requirements].sort((a, b) => a.ordinal - b.ordinal))
    lines.push(`- R${r.ordinal} [${r.verdict}] id ${r.id}: ${r.text}`);
  return lines.join('\n');
}

function recordsBlock(records: readonly PackRecord[]): string {
  const lines = ['## check records'];
  if (records.length === 0) lines.push('(no check ran for this unit)');
  for (const r of records)
    lines.push(
      `- ${r.checkId} on ${r.unit}: ${r.state}${r.recordId ? ` (record ${r.recordId})` : ''}`,
    );
  return lines.join('\n');
}

export function reviewPack(input: ReviewPackInput): ReviewPack {
  const cap = input.capBytes ?? REVIEW_PACK_CAP;
  const files = filesBlock(input.files, cap);
  const raw: [string, string][] = [
    [
      'review-pack:diff',
      `# Review pack — unit ${input.unitId} against ${input.baseRef}\n\n${files.block}`,
    ],
    ['review-pack:requirements', requirementsBlock(input.requirements)],
    ['review-pack:records', recordsBlock(input.records)],
  ];
  let masked = 0;
  const blocks = raw.map(([id, text]) => {
    const clean = maskSink(text, 'review-pack', input.known);
    masked += clean.masked;
    return { id, text: clean.text };
  });
  const text = blocks.map((b) => b.text).join('\n\n');
  return {
    text,
    mode: files.inline ? 'inline' : 'file-list',
    sections: blocks.map((b) => ({ id: b.id, sha256: sha256(b.text), bytes: bytesOf(b.text) })),
    blocks,
    masked,
    bytes: bytesOf(text),
  };
}

/**
 * Требования и записи единицы из свёртки — только они: ни строк хода, ни инструментов, ни
 * заявления автора. Запись — прогон шага этой единицы.
 */
export function reviewInputsOf(
  state: Pick<TaskFoldState, 'requirements' | 'checks' | 'steps'>,
  unitId: string,
): { requirements: PackRequirement[]; records: PackRecord[] } {
  const requirements = Object.entries(state.requirements).map(([id, r]) => ({
    id,
    ordinal: r.ordinal,
    text: r.text,
    verdict: r.verdict,
  }));
  const records: PackRecord[] = [];
  for (const run of Object.values(state.checks)) {
    const stepId = run.run?.stepId;
    if (!run.run || !stepId || state.steps[stepId]?.unitId !== unitId) continue;
    records.push({
      checkId: run.run.checkId,
      unit: run.run.unit,
      state: run.state,
      recordId: run.recordId ?? null,
    });
  }
  return { requirements, records };
}
