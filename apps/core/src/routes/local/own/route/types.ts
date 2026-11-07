import type {
  Dialect,
  ReleaseOutcome,
  Route,
  RouteCaps,
  RouteLease,
  RouteRecorder,
} from '@agentdeck/contracts/core/routes';
import type { GpuMemory } from '../../../../platform/gpu.ts';
import type { Fact } from '../../../../platform/os-kind.ts';
import type {
  Liveness,
  LivenessProbe,
  ProcessIdentity,
} from '../../../../platform/process-identity.ts';
import type { WaitOwner } from '../lease-state.ts';
import type { SlotHold, SlotQueue, SlotReservation } from '../slot.ts';
import type { SlotWaitDecision, SlotWaitSubject } from '../slot-wait.ts';
import type { RunningRouter } from '../server.ts';

// Типы и мелкие помощники маршрута `local:own` — общие для его модулей (фасад — `../own.ts`).

export interface OwnModel {
  id: string;
  /** Файл GGUF; маршрут его только читает. */
  path: string;
  sizeBytes: number;
  contextTokens?: number;
  tools?: boolean;
  /** Аргументы экземпляра модели в пресете (`server.ts` `PresetModel.args`). */
  args?: Readonly<Record<string, string>>;
  /**
   * Сколько памяти карты требует этот запуск по раскладке вызывающего (слои + окно + кеш);
   * 0 — сервер раскладывает слои сам (`--fit on`) или считает на процессоре. Нет — файл + запас.
   */
  needBytes?: number;
}

export interface OwnRouteOptions {
  id?: string;
  server: {
    command: string;
    leadArgs?: readonly string[];
    extraArgs?: readonly string[];
    env?: Record<string, string>;
  };
  models: readonly OwnModel[];
  /** Каталог аренд в домашнем каталоге ядра: пресет, cwd сервера и запись аренды. */
  workRoot: string;
  overheadBytes?: number;
  toleranceBytes?: number;
  /** Сколько ждать, пока драйвер вернёт память после остановки. */
  settleMs?: number;
  startTimeoutMs?: number;
  loadTimeoutMs?: number;
  unloadTimeoutMs?: number;
  gpu?: () => Promise<Fact<GpuMemory>>;
  ram?: () => { totalBytes: number; freeBytes: number };
  /** Общая очередь слотов машины; по умолчанию одна на процесс ядра. */
  slots?: SlotQueue;
  slotKey?: string;
  /** Это ядро (`clock.bootId`) — владелец записанных мест ждущих; нет — своя загрузка на экземпляр. */
  core?: { bootId: string };
  /** Решения маршрута вне аренды задачи (снятое место ждущего упавшего ядра) — журнал ядра. */
  journal?: RouteRecorder;
  /** Сколько держать место ждущего упавшего ядра до его повторной выдачи. */
  reissueWindowMs?: number;
  /** Срок повторов `process.alive` при `unknown`; по умолчанию — из реестра классов чтения. */
  livenessRetryMs?: number;
  /** Как часто перечитывать непрояснённое (живость «неизвестно», окна мест). */
  recheckMs?: number;
  /** Живость по личности; тесты подставляют «неизвестно». */
  probe?: LivenessProbe;
}

/** Маршрут своей модели: обычный маршрут + чистая остановка вместе с ядром. */
export interface OwnRoute extends Route {
  /** Освободить все аренды маршрута (свои и возвращённые) полным протоколом, с записью исхода. */
  shutdown(record: RouteRecorder): Promise<ReleaseOutcome>;
  /**
   * Вернуть себе аренды прошлого ядра сейчас, не дожидаясь первой выдачи: держатель, которого
   * никто не спрашивает (удержание панели), иначе оставил бы слот свободным рядом с живым сервером.
   */
  restore(): Promise<void>;
  /** Слот карты этого маршрута держит кто-то сейчас (любой маршрут на той же очереди слотов). */
  slotHeld(): boolean;
}

export const MIB = 1024 ** 2;

export const OWN_CAPS: RouteCaps = {
  dialects: ['openai-chat', 'anthropic-messages'],
  tools: true,
  images: false,
  streaming: true,
  maskable: true,
  offline: true,
  binding: { via: 'endpoint' },
  // Окно, сроки и простой локального сервера CLI обязан знать (11 R:PR-04).
  limitsToTell: true,
  // Одна своя модель на машине — одно место распределителя (P141).
  sessionCap: 1,
};

export interface Held {
  lease: RouteLease;
  hold: SlotHold;
  router?: RunningRouter;
  /** Есть — подбор сказал «влезает», загрузка была: сверять память карты с этой базой. */
  vram?: { baselineUsedBytes: number | undefined; baselineDevices?: Record<string, number> };
  dialect: Dialect;
  workDir: string;
  /**
   * Слот отдан раньше освобождения аренды: сервер прочитан мёртвым по личности (при возврате
   * прошлого ядра или перепроверкой). Память карты с тех пор может принадлежать другой аренде.
   */
  slotReturned?: string;
  /**
   * Запуск сервера не поднялся, а остановка его дерева не доказана (остаток или «неизвестно»,
   * F-64): освобождение называет это утечкой под меткой сервера и не отдаёт слот.
   */
  startLeft?: { rid: string; text: string; root: ProcessIdentity | number; since?: number };
}

/** Аренда живого (или непрояснённого) чужого ядра: держится только слот за ней (F-88). */
export interface ForeignLease {
  hold: SlotHold;
  workDir: string;
}

export const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

export const NO_HOLD = (key: string): SlotHold => ({ key, release: () => undefined });

/** Держатель слота / места, чья судьба после перезапуска ещё не решена (11 R:PR-04, F09). */
export interface Pending {
  subject: SlotWaitSubject;
  /** Чью живость читать; нет — владелец не записан (`absent`). */
  identity?: ProcessIdentity;
  /** Прочитанное окончательно (`dead`, `absent`) больше не перечитывается. */
  settled?: 'dead' | 'absent';
  /** Владелец места ждущего, как записан в файле места. */
  owner?: WaitOwner;
  /** Кого называет точка человека и запись журнала. */
  label: string;
  /** Место в очереди; сервер — впереди всех. */
  rank: number;
  leaseId?: string;
  /** Каталог чужой аренды (`lease`): ушёл — ядро-владелец её освободило. */
  workDir?: string;
  taskId?: string;
  reservation?: SlotReservation;
  /**
   * С какого мига считается срок без факта смерти: возврат состояния этим ядром, а место,
   * выданное заново другому владельцу, — с мига, когда это ядро новую выдачу увидело.
   */
  since: number;
  /** Срок вышел: точка человека поднята для `told` (место — один раз на ждущую задачу, на диске). */
  stuck?: {
    reason: string;
    decision: SlotWaitDecision;
    elapsedMs: number;
    live: LivenessRead['live'];
  };
  told: Set<LiveWaiter>;
}

/** Ждущий этого ядра: ему приходят решения о тех, кто стоит впереди. */
export interface LiveWaiter {
  taskId: string;
  rank: number;
  record: RouteRecorder;
}

export interface LivenessRead {
  live: Liveness | 'absent';
  reason?: string;
}

/** Как место ждущего названо в журнале и в точке человека: задача, слот, ядро-владелец. */
export const waiterLabel = (slotKey: string, taskId: string, owner?: WaitOwner): string =>
  owner
    ? `waiter ${taskId} on slot ${slotKey} of core pid ${owner.pid} start ${owner.start} boot ${owner.bootId}`
    : `waiter ${taskId} on slot ${slotKey} (owner not recorded)`;

export const kindOf = (live: LivenessRead['live']): 'value' | 'absent' | 'unknown' =>
  live === 'unknown' ? 'unknown' : live === 'absent' ? 'absent' : 'value';

export function factKind(fact: Fact<unknown>): 'value' | 'absent' | 'unknown' {
  if ('value' in fact) return 'value';
  return 'absent' in fact ? 'absent' : 'unknown';
}
