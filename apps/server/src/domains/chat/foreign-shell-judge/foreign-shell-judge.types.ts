import type { DeferredScope } from '@agentdeck/contracts/deferred-asks';
import type { DeferredAskRecord } from '../deferred-asks/deferred-asks.types.ts';
import type { GuardHit } from '../../backend-guard/guard-script.mjs';
import type { GroupAutoApprove, GroupPermissionSource } from '../group-permissions.ts';
import type { GroupNoticeStore } from '../group-permissions.ts';

/** Оболочка, которой чужой CLI исполнит команду; `unknown` — судится обоими чтениями. */
export type ForeignShellKind = 'powershell' | 'bash' | 'cmd' | 'unknown';

/** Вызов оболочки чужого CLI, пришедший просьбой о разрешении. */
export interface ForeignShellCall {
  /** Ключ разговора (`foreignChatKey`) — по нему связь с группой и записи D-n. */
  readonly key: string;
  /** Чей CLI — по нему правила `ask`/`deny` самого CLI (P-05). */
  readonly providerId: string;
  /** Каталог разговора (копия группы или проект одиночного чата). */
  readonly workdir: string | undefined;
  /** Каталог оболочки, если CLI его назвал (`params.cwd` codex, `directory` qwen). */
  readonly cwd?: string;
  readonly command: string;
  readonly shell: ForeignShellKind;
  /** Переключатель «Разрешить правки» разговора. */
  readonly allowEdits: boolean;
  /** Заголовок разговора — подпись D-n. */
  readonly title?: string;
  /** pid процесса CLI хода — корень живого дерева для суда погашения (P-06). */
  readonly pid?: number;
}

/** Решение судьи: `human` — карточка человеку (только одиночный чат). */
export type ForeignShellVerdict =
  | { readonly behavior: 'allow' }
  | { readonly behavior: 'deny'; readonly message: string }
  | { readonly behavior: 'human' };

/** Хранилище D-n — та же запись, что у маршрута прав Claude. */
export interface ForeignDeferredAsks {
  consume(scope: DeferredScope, toolName: string, input: unknown): DeferredAskRecord | undefined;
  retryOf(scope: DeferredScope, toolName: string, input: unknown): DeferredAskRecord | undefined;
}

/**
 * Выходы маршрута прав Claude (`routes/chat/run-routes/deferred-bridge.ts`,
 * `run-routes.ts`), которые домен не импортирует сам: слой маршрутов выше.
 * Подаёт их сборка (`bootstrap/runtime`), тесты — свои.
 */
export interface ForeignShellBridge {
  readonly asks: () => ForeignDeferredAsks;
  readonly scopeOf: (keys: readonly string[]) => DeferredScope;
  readonly reachesPanelDecision: (toolName: string, input: unknown) => boolean;
  readonly deliveryRefusal: (
    asks: ForeignDeferredAsks,
    scope: DeferredScope,
    toolName: string,
    input: unknown,
  ) => string | undefined;
  readonly protectedWriteRefusal: (
    toolName: string,
    input: unknown,
    cwd: string | undefined,
    base: string | undefined,
  ) => Promise<string | undefined>;
  /** Завести D-n (`deferCall` + `deferReason` + `sourceOfRun`), вернуть текст отказа. */
  readonly defer: (call: {
    scope: DeferredScope;
    keys: string[];
    toolName: string;
    input: unknown;
    guard: GuardHit | undefined;
    cwd: string;
    title?: string;
  }) => string;
  /** Состояние MR группы (`withMrState` маршрута): нужно пушу своей ветки на ревью. */
  readonly withMrState: (
    group: GroupAutoApprove,
    toolName: string,
    input: unknown,
  ) => Promise<GroupAutoApprove>;
  /** Цель догона (`syncRefOf`); `unnamed` — цель не назвать. */
  readonly syncRefOf: (
    group: GroupAutoApprove,
    cwd: string,
    toolName: string,
    command: string,
  ) => Promise<string | 'unnamed' | undefined>;
}

/** Всё, что судья читает снаружи: хранилище, правила, защита бэкенда. */
export interface ForeignShellJudgeDeps {
  readonly store: GroupPermissionSource & GroupNoticeStore;
  readonly bridge: ForeignShellBridge;
  /** Признак «за звеном — доставка» (`stagesAhead(link, deliverAhead).deliver`). */
  readonly deliverAhead: (key: string) => boolean;
  /** Правила, включённые человеком в настройках автоподтверждения (`autoApproveRules`). */
  readonly autoApproveRules: () => ReadonlySet<string>;
  /** Правила `ask`/`deny` самого CLI в форме `Tool(spec)` (P-05). */
  readonly guardedPatterns: (providerId: string) => string[];
  /** Защита бэкенда проекта (`guardHitFor`). */
  readonly guardHit: (
    cwd: string | undefined,
    toolName: string,
    input: unknown,
  ) => GuardHit | undefined;
}
