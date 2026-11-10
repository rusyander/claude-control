import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import type { TaskFoldPublish, TaskFoldState, UnitPublication } from './reduce.types.ts';

/**
 * Свёртка видов публикации этапа 6 (свёртка v8): собранное к публикации, личность MR, единственное
 * чтение нитей, CI, ожидание форжа, «опубликовать сейчас», закрытие копий и ссылки удалённого.
 * Чистая, как `reduce`: противоречие — аномалия, запись не трогается. Зовётся после основной
 * свёртки каждой строки (`reduce.ts`), поэтому видит и `command.applied`.
 */

type Anomaly = (reason: string) => TaskFoldState;

/** Ключ базы ссылок удалённого: репозиторий + имя remote; запись без репозитория — по имени. */
export function remoteRefsKey(repoKey: string | undefined, remote: string): string {
  return repoKey ? `${repoKey}\u0000${remote}` : remote;
}

export function initialPublish(): TaskFoldPublish {
  return { publication: {}, closures: {}, remoteRefs: {} };
}

export const EMPTY_PUBLICATION: UnitPublication = {
  composed: null,
  mr: null,
  read: null,
  ci: null,
  backoff: null,
  publishNowSeq: null,
};

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Публикация единицы в свёртке; нет записи — пустая (чтение без побочных записей). */
export function publicationOf(state: TaskFoldState, unitId: string): UnitPublication {
  return own(state.publication, unitId) ?? EMPTY_PUBLICATION;
}

function withUnit(
  state: TaskFoldState,
  unitId: string,
  patch: Partial<UnitPublication>,
): TaskFoldState {
  const prev = publicationOf(state, unitId);
  return { ...state, publication: { ...state.publication, [unitId]: { ...prev, ...patch } } };
}

function data<K extends keyof JournalDataV1>(line: JournalLine, _kind: K): JournalDataV1[K] {
  return line.data as unknown as JournalDataV1[K];
}

/** Применённая `publish-now`: единица из тела принятой команды (`command.received.fields`). */
function publishNow(state: TaskFoldState, line: JournalLine): TaskFoldState {
  if (line.kind !== 'command.applied' || !line.cmdId) return state;
  if (own(state.commands, line.cmdId)?.kind !== 'publish-now') return state;
  const outcome = (line.data as { outcome?: { unitId?: unknown } }).outcome;
  const unitId = typeof outcome?.unitId === 'string' ? outcome.unitId : null;
  return unitId ? withUnit(state, unitId, { publishNowSeq: line.seq }) : state;
}

export function reducePublish(
  state: TaskFoldState,
  line: JournalLine,
  anomaly: Anomaly,
): TaskFoldState {
  const seq = line.seq;
  switch (line.kind) {
    case 'action.started': {
      // Единица действия — из строки (`runAction` пишет её в область), чтобы публикатор после
      // краха нашёл свои начатые действия и не повторил эффект (P10).
      const d = data(line, 'action.started');
      const action = own(state.actions, d.actionId);
      if (!action || !line.unitId || action.unitId) return state;
      return {
        ...state,
        actions: { ...state.actions, [d.actionId]: { ...action, unitId: line.unitId } },
      };
    }
    case 'publish.composed': {
      const d = data(line, 'publish.composed');
      return withUnit(state, d.unitId, { composed: { ...d, seq } });
    }
    case 'publish.mr': {
      const d = data(line, 'publish.mr');
      const prev = publicationOf(state, d.unitId).mr;
      if (prev && (prev.mrId !== d.mrId || prev.mrIid !== d.mrIid)) {
        return anomaly(`unit ${d.unitId} MR ${prev.mrIid} named again as ${d.mrIid}`);
      }
      return prev ? state : withUnit(state, d.unitId, { mr: { ...d, seq } });
    }
    case 'publish.mr-state': {
      // Этап 12: конец MR без его личности в журнале — противоречие (чей MR слит?).
      const d = data(line, 'publish.mr-state');
      if (!publicationOf(state, d.unitId).mr) {
        return anomaly(`unit ${d.unitId} MR ${d.state} before publish.mr`);
      }
      return withUnit(state, d.unitId, { mrState: { ...d, seq } });
    }
    case 'publish.read': {
      const d = data(line, 'publish.read');
      if (publicationOf(state, d.unitId).read) {
        return anomaly(`unit ${d.unitId} threads read twice (read once at MR open)`);
      }
      return withUnit(state, d.unitId, { read: { ...d, seq } });
    }
    case 'publish.ci': {
      const d = data(line, 'publish.ci');
      return withUnit(state, d.unitId, { ci: { ...d, seq } });
    }
    case 'publish.backoff': {
      const d = data(line, 'publish.backoff');
      return withUnit(state, d.unitId, { backoff: { ...d, seq, at: line.at } });
    }
    case 'publish.closure': {
      const d = data(line, 'publish.closure');
      return { ...state, closures: { ...state.closures, [d.unitId]: { ...d, seq } } };
    }
    case 'publish.remote-refs': {
      const d = data(line, 'publish.remote-refs');
      const key = remoteRefsKey(d.repoKey, d.remote);
      return { ...state, remoteRefs: { ...state.remoteRefs, [key]: { ...d, seq } } };
    }
    case 'command.applied':
      return publishNow(state, line);
    default:
      return state;
  }
}
