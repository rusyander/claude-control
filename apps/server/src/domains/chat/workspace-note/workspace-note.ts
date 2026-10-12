/**
 * Строка о тестах проекта (папка e2e, кейсы, команда прогона) в системной
 * дописке — одна на всю сессию (E6).
 *
 * Строка несёт состояние каталога — путь папки e2e, число спек, свою команду
 * проекта, — и пересчёт на каждом старте менял системный промпт посреди
 * разговора: CLI писал кэш всего разговора заново, а живой процесс из пула не
 * совпадал подписью и шёл холодным `--resume` (замер 12.10.2026 по 36 сессиям
 * копий: путь папки сменился между ходами). Поэтому системная строка
 * замораживается на первом ходе сессии, а перемена, если она есть, уезжает
 * В СООБЩЕНИИ хода — так же, как сводка детей (`children-brief.ts`), и так же
 * вырезается из ленты (`stripChildrenBrief`).
 */
export const WORKSPACE_TAG = 'agentdeck-workspace';
const LEAD = new RegExp(`^\\s*<${WORKSPACE_TAG}>[\\s\\S]*?</${WORKSPACE_TAG}>\\s*`);

/** Строка сессии: что стоит в её системной дописке и что агент знает последним. */
export interface SessionNote {
  system: string;
  delivered: string;
}

/** Ход сессии: системная строка и перемена, которую надо сказать сообщением. */
export interface NoteTurn {
  system: string;
  update?: string;
  state: SessionNote;
}

/** Сколько сессий помнить: дольше живущие вытесняются первыми. */
const MAX_SESSIONS = 1000;

export class SessionWorkspaceNotes {
  private readonly notes = new Map<string, SessionNote>();

  /**
   * Строки хода. Сессия незнакома (первый ход, перезапуск панели) — системная
   * строка нынешняя. Знакома — её прежняя, а нынешняя, если отличается от
   * последней сказанной, идёт переменой; `canDeliver` ложно (ход — команда
   * CLI, сообщение не дописать) — перемена ждёт следующего хода.
   */
  turn(sessionId: string | undefined, current: string, canDeliver: boolean): NoteTurn {
    const known = sessionId ? this.notes.get(sessionId) : undefined;
    if (!known) return { system: current, state: { system: current, delivered: current } };
    if (current === known.delivered || !canDeliver) return { system: known.system, state: known };
    return { system: known.system, update: current, state: { ...known, delivered: current } };
  }

  /** Сессия назвала свой id: её строка запоминается (повторно — освежается). */
  remember(sessionId: string, state: SessionNote): void {
    this.notes.delete(sessionId);
    this.notes.set(sessionId, state);
    const oldest = this.notes.keys().next();
    if (this.notes.size > MAX_SESSIONS && !oldest.done) this.notes.delete(oldest.value);
  }
}

/** Ход — команда CLI (`/compact`): её узнают, только пока она стоит первой. */
export function isCliCommand(prompt: string): boolean {
  return prompt.replace(LEAD, '').trimStart().startsWith('/');
}

/**
 * Перемена строки о тестах — блоком перед словами хода. Прежний блок (повтор
 * хода) снимается всегда; пустая нынешняя строка значит, что раздела тестов у
 * проекта больше нет.
 */
export function withWorkspaceUpdate(prompt: string, update: string | undefined): string {
  const bare = prompt.replace(LEAD, '');
  if (update === undefined || bare.trimStart().startsWith('/')) return bare;
  const line =
    update.replace(/[\r\n]+/g, ' ').trim() ||
    'the project has no QA workspace now; ignore that line.';
  return (
    `<${WORKSPACE_TAG}>The QA workspace changed since this conversation started; this replaces ` +
    `the QA workspace line in your instructions: ${line}</${WORKSPACE_TAG}>\n\n${bare}`
  );
}
