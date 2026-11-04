import type { CommandEnvelope, CommandOutcome } from '@agentdeck/contracts/core/commands';
import type { HopControlReply, HopControlRequest } from '@agentdeck/contracts/core/hops';
import type { DeliveryReply } from '@agentdeck/contracts/core/publish';
import type { RouteId, RouteKind } from '@agentdeck/contracts/core/routes';
import type { ContourPolicy } from '../../policy/resolve/resolve.types.ts';
import type { ModelRank } from '../../policy/resolve/risky.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import type { SplitEnv } from '../estimate/index.ts';

export type CommandResult = CommandOutcome & { state?: TaskFoldState };

/**
 * Среда, в которой исполняются команды человека: её даёт тот, кто принимает команду (API ядра,
 * тест), а не путь задачи и не глобальная привязка. `layout` — дом ядра (библиотека сценариев и
 * прочее); `split()` — среда деления запущенного дирижёра. Дирижёр не запущен или остановлен —
 * `undefined`, и запуск, утверждение и правка деления отказывают `preflight-unwired`, а не идут
 * мимо предпроверки. Порт, а не значение: API собирается раньше дирижёра.
 */
export interface CommandEnv {
  layout: CoreHomeLayout;
  split(): SplitEnv | undefined;
  /** Реестр маршрутов и активный контур для `set-route`; нет — отказ `routes-unwired`. */
  routes?(): SetRoutePorts | undefined;
  /** Управление хостом звеньев для `clear-exhausted`; нет — отказ `hop-unwired`. */
  hops?(): ClearExhaustedPort | undefined;
  /** Публикатор для `publish-now` и `clean-remote`; нет — отказ `publisher-unwired`. */
  publisher?(): PublisherCommandPort | undefined;
  /**
   * Ранги моделей — факт переходника (P108): дирижёр их не знает, загрузка даёт `ladderRank` по
   * лестницам переходников (`bootEconomy.ladders`). Нет — ранг неизвестен, и предупреждение `set-model` называет это, а не молчит.
   */
  modelRank?: ModelRank;
  /**
   * Сверка загрузки (`bootstrap/boot-reconcile.ts`) для ответа «повторить сверку» на точку 4: нет —
   * действие всё равно снова начатое в журнале, его прочтёт следующая загрузка ядра.
   */
  reconcile?(): ReconcileRecheckPort | undefined;
}

/** Повторная сверка по таймеру загрузки: названное действие идёт в ближайший проход. */
export interface ReconcileRecheckPort {
  recheck(taskId: string, actionId: string): void;
}

export interface CleanRemoteReport {
  /** Удалены и чтением сервера подтверждены как отсутствующие. */
  deleted: string[];
  /** Ссылки не было на сервере — удалять нечего. */
  absent: string[];
  failed: { ref: string; code: string }[];
}

/** Порт публикатора (зона P этапа 6): дирижёр не импортирует части и проводку, порт даёт загрузка. */
export interface PublisherCommandPort {
  /** «Опубликовать сейчас»: ждущая единица — в голову очереди своего репозитория (P96). */
  promote(unitId: string): void;
  /** Удалить ровно названные ссылки сервера каждого репозитория задачи через outbox (P102). */
  cleanRemote(
    task: LiveTask,
    input: { refs: string[]; remote: string | null },
  ): Promise<CleanRemoteReport | { unknown: string }>;
  /**
   * Проба сдачи копии единицы тем же судом, что шаг публикации (`GET /v1/delivery`,
   * `tests-cli delivery`); копия не единицы ядра — `missing`.
   */
  delivery(copy: string): Promise<DeliveryReply | { missing: string }>;
}

/** Что `set-route` нужно знать о маршрутах загрузки: реестр и активный контур. */
export interface SetRoutePorts {
  routeOf(id: RouteId): { kind: RouteKind } | undefined;
  contour?: ContourPolicy;
}

/** Управляющий запрос звену `clear-exhausted` (клиент `routes/hops`). */
export type ClearExhaustedPort = (
  request: Extract<HopControlRequest, { op: 'clear-exhausted' }>,
) => Promise<HopControlReply>;

/**
 * Применение одного вида команды: приём, полномочия и `expectSeq` уже пройдены
 * (`process.ts`), осталось действие и его исход в журнале — `command.applied` или
 * `command.rejected`, ровно одна строка исхода на `cmdId` (P47).
 */
export type ApplyCommand = (
  task: LiveTask,
  command: CommandEnvelope,
  env: CommandEnv,
) => Promise<CommandResult>;
