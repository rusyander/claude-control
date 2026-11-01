import type { Fact } from '@agentdeck/contracts/core/facts';
import { unitDiffSchema } from '@agentdeck/contracts/core/model-tools';
import { maskSink } from '../../context/sinks/index.ts';

/**
 * Инструмент модели `unit_diff(file)` (03 §Context «per-file diff on request»): пакет ревью сверх
 * предела называет файлы списком, тело файла ревьюер берёт здесь — только файл из диффа
 * единицы (иначе инструмент читал бы копию мимо прав шага), под маской выхода `review-pack`.
 * Тело длиннее предела — срез с меткой и указанием, где читать остальное: молча обрезанный дифф
 * выглядел бы законченным. Схема и описание — в контракте (`MODEL_TOOL_SCHEMAS.unit_diff`), набор
 * шагов — `toolPlanFor` (ревью и ответ ревьюерам).
 */

/** Предел тела одного файла в ответе, байт. */
export const UNIT_DIFF_FILE_CAP = 60_000;

export interface UnitDiffDeps {
  /** Изменённые файлы единицы против базы (`diffUnit`, класс `git.diff-unit`). */
  changed(): Promise<Fact<string[]>>;
  /** Тело диффа файла против базы; `absent` — у git тела нет (новый неотслеживаемый). */
  diffOf(file: string): Promise<Fact<string>>;
  /** Значения, известные ядру секретом по имени (окружение сеанса): маска по значению (P61). */
  known?: readonly string[];
}

export type UnitDiffReply =
  | { ok: true; file: string; diff: string; cut: number; masked: number }
  | { ok: false; code: 'invalid' | 'not-in-unit' | 'unknown'; message: string };

const norm = (path: string): string => path.replaceAll('\\', '/').replace(/^\.\//, '');

function cutTo(text: string, cap: number, file: string): { text: string; cut: number } {
  const all = Buffer.byteLength(text, 'utf8');
  if (all <= cap) return { text, cut: 0 };
  let kept = Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8');
  // Половина многобайтного символа декодируется в U+FFFD — убираем её.
  if (kept.endsWith('�')) kept = kept.slice(0, -1);
  const cut = all - Buffer.byteLength(kept, 'utf8');
  return {
    text: `${kept}\n[… ${cut} bytes of the diff cut: read ${file} in the copy for the rest]`,
    cut,
  };
}

export async function unitDiff(
  args: unknown,
  deps: UnitDiffDeps,
  cap = UNIT_DIFF_FILE_CAP,
): Promise<UnitDiffReply> {
  const parsed = unitDiffSchema.safeParse(args);
  if (!parsed.success)
    return {
      ok: false,
      code: 'invalid',
      message: 'unit_diff takes {"file": "<path from the pack>"}',
    };
  const file = norm(parsed.data.file);
  const changed = await deps.changed();
  if (!('value' in changed))
    return {
      ok: false,
      code: 'unknown',
      message: `unit diff unreadable: ${'unknown' in changed ? changed.unknown : 'absent'}`,
    };
  if (!changed.value.map(norm).includes(file))
    return { ok: false, code: 'not-in-unit', message: `${file} is not changed in this unit` };
  const body = await deps.diffOf(file);
  if ('unknown' in body)
    return { ok: false, code: 'unknown', message: `diff of ${file} unreadable: ${body.unknown}` };
  // Маска — до среза: срез посреди ключа оставил бы хвост, который детектор уже не узнает.
  const clean = maskSink(
    'value' in body
      ? body.value
      : `${file}: no git body (new untracked file) — read it in the copy`,
    'review-pack',
    deps.known,
  );
  const fitted = cutTo(clean.text, cap, file);
  return { ok: true, file, diff: fitted.text, cut: fitted.cut, masked: clean.masked };
}
