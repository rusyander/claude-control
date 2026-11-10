import type { BoardSource } from '@agentdeck/contracts/core/board';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import { INBOX_DEFAULTS, type InboxSource } from '@agentdeck/contracts/core/inbox';
import type { ConfigPort } from '../api/config.types.ts';
import type { BoardPort } from '../conductor/board/board.types.ts';
import type { InboxPort } from '../conductor/inbox/inbox.types.ts';
import { createInboxPoller, type SourceReport } from '../conductor/inbox/poller.ts';
import { sha256Of } from '../conductor/inbox/kind.ts';
import { configFilesOf } from '../platform/core-config/files.ts';
import { readConfigState } from '../platform/core-config/state.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import type { Note } from './boot/boot.types.ts';
import { forgeInboxOfPanel, jiraOfPanel, type PanelTrackerDeps } from './panel-trackers.ts';

/**
 * Проводка входящих ядра (этап 12, D16–D18, P163–P167, P183). Опрос — при старте и потом каждые
 * `inbox.pollMs`; такт раз в `tickMs` (30 с) смотрит, не пора ли и не сменился ли раздел `inbox`
 * (новый источник опрашивается сразу, а не через пять минут). Круг — один за раз. Трекер и форж —
 * по настройкам панели, только чтение (P165); без каталога панели источники «неизвестно».
 * Автоочередь (D28) — только по записи настройки человека, которая её включила: `cmdId` этой
 * записи становится доказательством `config` записи доски, и запускатель перепроверяет его на
 * старте (`conductor/board/proof.ts`).
 */

export interface InboxWiringDeps {
  layout: CoreHomeLayout;
  note: Note;
  config: ConfigPort;
  /** Доска: записи из входящих кладутся только через её хранилище (один писатель, P181). */
  board: () => BoardPort | undefined;
  /** Каталог данных панели; `null` — ядро без панели: источники не читаются, «неизвестно». */
  panelAppData: string | null;
  now: () => number;
  /** Сеть трекера и форжа — тестам (заглушка на loopback); по умолчанию сеть ядра. */
  net?: PanelTrackerDeps;
  /** Такт проверки «пора ли опросить»; по умолчанию 30 с. */
  tickMs?: number;
  /** Свои MR, которые ведёт опрос форжа (W2-D): «мой MR» из них — «уже ведётся», не запись. */
  watchedMrs?: () => Promise<ReadonlySet<string>>;
}

export interface InboxWiring {
  /** Входящие для API; `undefined` — проводка не собрана (501). */
  port(): InboxPort | undefined;
  /** После старта доски: таймер опроса. */
  start(): void;
  /** Перед остановкой дирижёра, с ожиданием: идущий круг опроса ещё может положить запись. */
  stop(): Promise<void>;
  /** Один круг опроса сейчас (идёт — тот же круг): тестам и такту. */
  poll(): Promise<SourceReport[]>;
}

export const INBOX_TICK_MS = 30_000;

/** Записи настройки, доказывающие человека (08e): подпись устройства или nonce + пир. */
const HUMAN_CONFIG_BY: ReadonlySet<string> = new Set(['nonce+peer', 'device-signature']);

/** Предупреждение записи настройки, включившей автоочередь источника (`core-config/widen.ts`). */
export function autoQueueWarning(sourceId: string): { section: string; detail: string } {
  return { section: 'inbox', detail: `autoQueue on ${sourceId}` };
}

/** Запись настройки — человек и включила автоочередь этого источника. */
export function enablesAutoQueue(
  cmd: { by: string; warnings: readonly { section: string; detail: string }[] },
  sourceId: string,
): boolean {
  const want = autoQueueWarning(sourceId);
  return (
    HUMAN_CONFIG_BY.has(cmd.by) &&
    cmd.warnings.some((w) => w.section === want.section && w.detail === want.detail)
  );
}

/** Последняя запись настройки человека, включившая автоочередь источника; нет — `null`. */
export function autoQueueCmdOf(layout: Pick<CoreHomeLayout, 'config'>, sourceId: string) {
  const state = readConfigState(configFilesOf(layout).state);
  if (!('value' in state)) return null;
  const cmd = [...state.value.cmds]
    .reverse()
    .find((c) => isUuidv7(c.cmdId) && enablesAutoQueue(c, sourceId));
  return cmd?.cmdId ?? null;
}

export function createInboxWiring(deps: InboxWiringDeps): InboxWiring {
  const note = (message: string): void => deps.note('inbox', { message });
  const tickMs = deps.tickMs ?? INBOX_TICK_MS;
  const poller = createInboxPoller({
    config: () => deps.config.view(),
    tracker: () => jiraOfPanel(deps.panelAppData, deps.net),
    forgeInbox: () => forgeInboxOfPanel(deps.panelAppData, deps.net),
    board: deps.board,
    autoQueueCmd: (source) =>
      inboxAutoQueueOf(deps.config.view(), boardSourceOf(source))
        ? autoQueueCmdOf(deps.layout, source.id)
        : null,
    now: deps.now,
    note,
    ...(deps.watchedMrs ? { watchedMrs: deps.watchedMrs } : {}),
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastAt = 0;
  let lastDigest = '';
  let stopped = false;
  let inflight: Promise<unknown> | null = null;

  const sectionDigest = (): string => {
    const view = deps.config.view();
    if ('unknown' in view) return '';
    return sha256Of(JSON.stringify(view.value.doc.inbox ?? null));
  };

  const poll = (): Promise<SourceReport[]> => {
    if (stopped) return Promise.resolve([]);
    lastAt = deps.now();
    lastDigest = sectionDigest();
    const run = poller.poll().catch((error: unknown) => {
      note(`inbox: poll failed: ${String(error)}`);
      return [] as SourceReport[];
    });
    inflight = run;
    return run;
  };

  const tick = (): void => {
    const view = deps.config.view();
    const pollMs =
      'unknown' in view
        ? INBOX_DEFAULTS.pollMs
        : (view.value.doc.inbox?.pollMs ?? INBOX_DEFAULTS.pollMs);
    if (deps.now() - lastAt >= pollMs || sectionDigest() !== lastDigest) void poll();
  };

  return {
    port: () => poller.port,
    start() {
      if (timer || stopped) return;
      void poll();
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await inflight;
    },
    poll,
  };
}

/** Источник доски, как его кладёт опрос этого источника входящих. */
function boardSourceOf(source: InboxSource): BoardSource {
  return {
    kind: source.system === 'jira' ? 'tracker' : 'forge',
    system: source.id,
    title: source.id,
  };
}

/**
 * Можно ли записи этого источника встать в очередь без хода человека (D28, P183): только запись
 * опроса трекера или форжа, чей источник в ДЕЙСТВУЮЩЕМ разделе `inbox` включён с `autoQueue`.
 * Ручная, из чата, из «Тестов» и из Telegram — никогда (D29: Telegram — ручная запись). Дрейф
 * файла и непрочитанная настройка — `false`: запись ждёт человека.
 */
export function inboxAutoQueueOf(
  config: ReturnType<ConfigPort['view']> | undefined,
  source: BoardSource,
): boolean {
  if (source.kind !== 'tracker' && source.kind !== 'forge') return false;
  if (!config || 'unknown' in config) return false;
  if (config.value.drift) return false;
  const found = config.value.doc.inbox?.sources.find((s) => s.id === source.system);
  if (!found?.enabled || found.autoQueue !== true) return false;
  return (found.system === 'jira') === (source.kind === 'tracker');
}
