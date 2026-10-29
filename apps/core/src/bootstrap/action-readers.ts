import { absent } from '../lib/facts/read-fact.ts';
import { stubReader, type ActionFactReaders } from '../conductor/reconcile.ts';
import { containerActionReaders } from '../conductor/services.ts';
import { copyState } from '../platform/copy-git.ts';
import { markerSweep } from '../platform/env-marker.ts';
import { listDir } from '../platform/safe-io/files.ts';

/**
 * Читатели фактов сверки (01 §Outbox): копия — каталог на диске; процесс — по метке окружения
 * дерева из `idempotencyHint` (`NAME=VALUE`); контейнер сервиса — движком по меткам задачи
 * (класс `container.by-label`, зона F). Пуш, MR, ответ, трекер — заглушки фазы 6: они отвечают
 * `unknown`, и сверка спрашивает человека по сроку.
 */

function dirFact(path: string): string | { absent: true } {
  const read = listDir(path);
  if ('value' in read) return `dir ${path}`;
  if ('absent' in read) return absent();
  throw new Error(read.unknown);
}

/**
 * Копия выложена? Рабочее дерево, которое git начал и не закончил (замок `initializing`), — ещё
 * не копия: `absent`, и сверка не говорит «сделано» по наполовину выложенному каталогу (G7).
 * Иной каталог — по-прежнему факт присутствия: повтор `copy-create` разбирает его сам.
 */
function copyFact(path: string): string | { absent: true } {
  const state = copyState(path);
  if ('unknown' in state) throw new Error(state.unknown);
  if ('absent' in state || state.value === 'initializing') return absent();
  return `${state.value} ${path}`;
}

export function actionReaders(): ActionFactReaders {
  return {
    push: stubReader(6),
    'mr-create': stubReader(6),
    'mr-update': stubReader(6),
    'thread-reply': stubReader(6),
    'tracker-write': stubReader(6),
    ...containerActionReaders(),
    'copy-create': (action) => () => copyFact(action.target),
    'copy-remove': (action) => () => dirFact(action.target),
    'process-start': (action) => async () => {
      const at = action.idempotencyHint.indexOf('=');
      if (at <= 0)
        throw new Error(`process-start hint is not NAME=VALUE: ${action.idempotencyHint}`);
      // Процесс запускается после записи `action.started` (fsync до эффекта): закрытый свой
      // процесс старше неё (ssh-agent на Linux) метку не несёт и сверку в «неизвестно» не уводит.
      const found = await markerSweep()(
        action.idempotencyHint.slice(0, at),
        action.idempotencyHint.slice(at + 1),
        { bornAfterMs: action.startedAt },
      );
      if ('unknown' in found) throw new Error(found.unknown);
      if ('absent' in found || found.value.length === 0) return absent();
      return found.value.map((p) => `${p.pid}@${p.start}`).join(',');
    },
  };
}
