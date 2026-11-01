import type { Fact } from '@agentdeck/contracts/core/facts';
import type { LiveTask } from '../../journal/resume.ts';
import type { StatusSnapshot } from '../../platform/git/status.ts';
import type { BriefSection } from '../run/run.types.ts';

/**
 * Ручные правки в копии (02 §User interventions, P69, G17). Снимок статуса — на конце хода и
 * шага (там копия такая, какой её оставила сессия); сверка — перед следующим шагом или заходом:
 * всё, что сдвинулось между ними, сделал не шаг. Правки самой сессии внутри хода сверка не видит
 * по построению — их снимок уже учёл.
 */

/** Сдвиг HEAD (коммит, сброс, смена ветки руками) — отдельной строкой: файлы его не покажут. */
export const HEAD_MOVED = 'HEAD';

/** Пути, чьё состояние в статусе сменилось; первый снимок — основа, правок у него нет. */
export function externalEdits(prev: StatusSnapshot | null, next: StatusSnapshot): string[] {
  if (!prev) return [];
  const out: string[] = [];
  if (prev.head !== next.head) out.push(HEAD_MOVED);
  const paths = new Set([...Object.keys(prev.entries), ...Object.keys(next.entries)]);
  for (const path of [...paths].sort()) {
    const a = prev.entries[path];
    const b = next.entries[path];
    if (!a || !b || a.xy !== b.xy || a.stamp !== b.stamp) out.push(path);
  }
  return out;
}

const SHOWN = 50;

/** Раздел брифа (`external-edits`): шаг знает, что под ним правили, и не затирает правку. */
export function externalEditsSection(files: string[]): BriefSection {
  const head = files.slice(0, SHOWN).map((f) => (f === HEAD_MOVED ? 'HEAD moved' : f));
  const more = files.length > SHOWN ? `\n… and ${files.length - SHOWN} more` : '';
  return {
    id: 'external-edits',
    from: 'conductor/human',
    text:
      'The human (or another tool) changed these paths in your copy since the last step. ' +
      'Treat them as intended: read them before editing, do not revert them.\n' +
      head.map((f) => `- ${f}`).join('\n') +
      more,
  };
}

/**
 * Сверка на границе: новый снимок против прошлого. Сдвиг — строка `copy.changed-externally` и
 * раздел брифа; непрочитанный статус — раздел «не прочитано», не «правок нет» (класс `git.status`,
 * `onUnknown: run`). Возвращает снимок, ставший основой.
 */
export function noteExternalEdits(
  task: LiveTask,
  at: { unitId: string; stepId: string | null },
  prev: StatusSnapshot | null,
  read: Fact<StatusSnapshot>,
): { base: StatusSnapshot | null; sections: BriefSection[] } {
  if (!('value' in read)) {
    const why = 'unknown' in read ? read.unknown : 'copy missing';
    return {
      base: prev,
      sections: [
        {
          id: 'external-edits',
          from: 'conductor/human',
          text: `Could not read the copy status (${why}); manual edits since the last step are unknown.`,
        },
      ],
    };
  }
  const files = externalEdits(prev, read.value);
  if (files.length === 0) return { base: read.value, sections: [] };
  task.append({
    kind: 'copy.changed-externally',
    actor: 'core',
    unitId: at.unitId,
    ...(at.stepId ? { stepId: at.stepId } : {}),
    data: { unitId: at.unitId, files },
  });
  return { base: read.value, sections: [externalEditsSection(files)] };
}
