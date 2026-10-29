import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { EngineInfo } from '@agentdeck/contracts/core/records';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';

/**
 * Записи ресурсов зоны F в журнале (`resource.created.ref`, 04:91): движок, id, рецепт, порт —
 * НИКОГДА адрес с паролем; адрес собирается заново из рецепта. По записи снятие после краха
 * говорит с тем же движком тем же CLI (`handleOf`).
 */

export interface ServiceContainerRef {
  engine: EngineInfo;
  id: string;
  recipe: string;
  /** Главный порт контейнера (не хоста): порт хоста читается заново (`publishedPorts`). */
  port: number | null;
  /** Метки, которые снятие сверяет до `rm` (задача, рецепт, тестовая метка зоны). */
  labels: Record<string, string>;
}

export interface CacheVolumeRef {
  engine: EngineInfo;
  name: string;
}

export interface StandRef {
  pid: number;
  start: string;
  /** Адрес здоровья: после снятия он должен молчать (чтение назад стенда). */
  health: string;
  /** Ключ наблюдения в реестре стендов (`<taskId>` или `<taskId>/<unit>`); нет — id задачи. */
  key?: string;
}

/** Подсказка сверки `container-*` (01 §Outbox): чем и где читать контейнер по меткам. */
export interface ContainerHint {
  labels: Record<string, string>;
  cli: EngineInfo['cli'];
  socket: string;
}

export interface ResourceRow {
  rid: string;
  kind: string;
  owner: 'core' | 'session';
  release: JournalLine<'resource.created'>['data']['release'];
  ref: string;
  seq: number;
}

/** Все `resource.created` задачи по порядку; статус — из свёртки (`task.state.resources`). */
export function resourceRows(task: LiveTask): ResourceRow[] {
  const out: ResourceRow[] = [];
  for (const line of readJournalLines(task.dir, task.taskId).lines) {
    if (line.kind !== 'resource.created') continue;
    const d = (line as JournalLine<'resource.created'>).data;
    out.push({
      rid: d.rid,
      kind: d.kind,
      owner: d.owner,
      release: d.release,
      ref: d.ref,
      seq: line.seq,
    });
  }
  return out;
}

/** Подсказки начатых `container-start` задачи: по ним конец задачи ищет незаписанные контейнеры. */
export function startHints(task: LiveTask): { recipe: string; hint: ContainerHint }[] {
  const seen = new Set<string>();
  const out: { recipe: string; hint: ContainerHint }[] = [];
  for (const line of readJournalLines(task.dir, task.taskId).lines) {
    if (line.kind !== 'action.started') continue;
    const d = (line as JournalLine<'action.started'>).data;
    if (d.kind !== 'container-start') continue;
    const v = parseRef(d.idempotencyHint);
    if (!v || typeof v.labels !== 'object' || v.labels === null || typeof v.socket !== 'string') {
      continue;
    }
    const hint = v as unknown as ContainerHint;
    const key = JSON.stringify([hint.labels, hint.cli, hint.socket]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ recipe: d.target, hint });
  }
  return out;
}

export function parseRef(ref: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(ref) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Контейнер сервиса ядра (запись зоны F) — движок записан объектом, а не именем CLI (зона D). */
export function asServiceContainer(ref: string): ServiceContainerRef | null {
  const v = parseRef(ref);
  if (!v || typeof v.engine !== 'object' || v.engine === null || typeof v.id !== 'string') {
    return null;
  }
  return v as unknown as ServiceContainerRef;
}

/** Набросок `EngineInfo` по подсказке сверки: `handleOf` читает только CLI и сокет. */
export function infoOfHint(hint: ContainerHint): EngineInfo {
  return {
    kind: 'docker-compatible',
    socket: hint.socket,
    composeV2: false,
    composeV1: false,
    cli: hint.cli,
    viaSocket: hint.socket.includes('://'),
    serverVersion: '',
    serverOs: '',
  };
}
