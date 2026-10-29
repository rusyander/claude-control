import type { RoadProbe } from '../preflight/index.ts';
import { absent } from '../../lib/facts/read-fact.ts';
import {
  EPHEMERAL_LABEL,
  containerPresent,
  engineFact,
  handleOf,
  listByLabels,
} from '../../platform/container-engine.ts';
import type { EngineProbeOptions } from '../../platform/container-engine.types.ts';
import type { ActionFactReader } from '../reconcile.ts';
import { infoOfHint, type ContainerHint } from './refs.ts';

/**
 * Читатели сверки `container-start` / `container-remove` (01 §Outbox, класс `container.by-label`)
 * и проба дороги `container-engine` предполётной проверки (04:105-112). Читатель бросает на
 * непрочитанном (`unknown` — повтор до срока класса, потом точка человека), `absent` — нет.
 */

function hintOf(raw: string): ContainerHint {
  const v = JSON.parse(raw) as ContainerHint;
  if (!v || typeof v.labels !== 'object' || typeof v.socket !== 'string') {
    throw new Error(`container hint is not {labels, cli, socket}: ${raw.slice(0, 80)}`);
  }
  return v;
}

function handleFor(hint: ContainerHint) {
  const h = handleOf(infoOfHint(hint));
  if ('value' in h) return h.value;
  throw new Error(`engine ${hint.cli}: ${'unknown' in h ? h.unknown : 'CLI not in PATH'}`);
}

/** Запуск случился, когда контейнер с метками задачи и рецепта есть (любой: запущенный ли, нет). */
export const containerStartReader: ActionFactReader = (action) => async () => {
  const hint = hintOf(action.idempotencyHint);
  const rows = await listByLabels(handleFor(hint), { ...hint.labels, [EPHEMERAL_LABEL]: '1' });
  if ('unknown' in rows) throw new Error(rows.unknown);
  if (!('value' in rows) || rows.value.length === 0) return absent();
  return rows.value.map((row) => row.id).join(',');
};

/** Снятие случилось, когда контейнера с этим id нет (сверка читает удаление как «нет предмета»). */
export const containerRemoveReader: ActionFactReader = (action) => async () => {
  const present = await containerPresent(handleFor(hintOf(action.idempotencyHint)), action.target);
  if ('unknown' in present) throw new Error(present.unknown);
  return 'value' in present && present.value ? `container ${action.target}` : absent();
};

export function containerActionReaders(): {
  'container-start': ActionFactReader;
  'container-remove': ActionFactReader;
} {
  return { 'container-start': containerStartReader, 'container-remove': containerRemoveReader };
}

/** Дорога `container-engine` (E вставляет её в `preflight(..., extra)`): нет движка — задача не стартует. */
export function engineRoadProbe(options: EngineProbeOptions = {}): RoadProbe {
  return async () => {
    const got = await engineFact(options);
    if ('value' in got) {
      const e = got.value;
      return {
        status: 'ok',
        detail: `${e.kind} ${e.serverVersion} via ${e.cli} @ ${e.socket}${e.composeV2 ? ', compose v2' : ''}`,
      };
    }
    if ('absent' in got) {
      return {
        status: 'fail',
        detail: 'no docker or podman CLI in PATH',
        fix: 'install Docker Desktop, Podman, Colima or OrbStack and put its CLI in PATH',
      };
    }
    if (got.unknown.startsWith('engine-down')) {
      return {
        status: 'fail',
        detail: got.unknown,
        fix: 'start the engine (Docker Desktop, `podman machine start`, `colima start`, OrbStack)',
      };
    }
    return { status: 'unknown', detail: got.unknown };
  };
}
