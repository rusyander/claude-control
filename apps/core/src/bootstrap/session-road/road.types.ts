import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ProtectedRootFinding } from '@agentdeck/contracts/core/records';
import type {
  CompatDecision,
  CredentialKind,
  Route,
  RouteKind,
  RouteLease,
} from '@agentdeck/contracts/core/routes';
import type {
  AdapterEvent,
  CliAdapter,
  DenySet,
  LayerMode,
  SessionHandle,
  SessionSpec,
  ToolSet,
} from '../../adapters/index.ts';
import type { StopMode, StopOutcome } from '../../adapters/launcher/launcher.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import type { LoginPath } from '../../platform/shell-path.ts';

/**
 * Типы ОДНОЙ дороги сессии ядра (03 §Launcher, 06 §Session permissions, 01 §Resources):
 * совместимость → окружение (PATH оболочки входа) → токен → хук ядра + оверлей запретов →
 * запуск → прикрепление к рантайму сессий → на остановке поиск ресурсов → в конце задачи их
 * снятие с чтением назад. Каждый, кто запускает сессию ядра, идёт этой дорогой.
 */

export interface RoadStart {
  task: LiveTask;
  stepId: string;
  stepKind: string;
  /** Id переходника и маршрута — из решения, не из имён (P109). */
  adapterId: string;
  routeId: string;
  model: string;
  effort?: string;
  sessionId: string;
  /** Каталог сессии в доме ядра (создаёт запуск). */
  dir: string;
  /** Корень копии единицы. */
  cwd: string;
  brief: string;
  /** Запреты шага; запреты платформы дорога добавляет сама. */
  deny: DenySet;
  tools: ToolSet;
  layer: { hooks: LayerMode };
  trust?: SessionSpec['trust'];
  /** Пин задачи (PATH, локаль, дом CLI). */
  pin: Record<string, string>;
  /** Каталоги PATH перед путём оболочки входа (данные стенда, node ядра). */
  pathPrefix?: readonly string[];
  /** Уже взятая аренда маршрута (пережила перезапуск ядра); нет — дорога берёт сама. */
  lease?: RouteLease;
  /** Свои пути единицы от корня копии; пусто — вся копия своя. */
  ownedPaths?: readonly string[];
  /** Исходный репозиторий копии: по нему из конфига ядра берётся список чтения человека. */
  sourceRepo?: string;
  resume?: { conversationId: string };
}

export interface Prepared {
  start: RoadStart;
  spec: SessionSpec;
  adapter: CliAdapter;
  route: Route;
  lease: RouteLease;
  compat: CompatDecision;
  token: string;
  context: PermitContext;
  loginPath: LoginPath;
  credentialKind: CredentialKind;
  routeKind: RouteKind;
  /** Подсказка идемпотентности `process-start`: метка дерева сессии. */
  hint: string;
}

export type PrepareOutcome =
  { ok: true; prepared: Prepared } | { ok: false; reason: string; compat?: CompatDecision };

export interface RoadAttach {
  task: LiveTask;
  sessionId: string;
  adapter: CliAdapter;
  handle: SessionHandle;
  context: PermitContext;
  cwd: string;
  resumed?: boolean;
  replayed?: number;
  onEvent?: (event: AdapterEvent) => void;
}

/** Ресурс, найденный на остановке сессии: уже в журнале (`resource.created`). */
export interface FoundResource {
  rid: string;
  kind: 'tmpdir' | 'port' | 'process' | 'copy' | 'container';
  ref: string;
}

export interface SessionEnd {
  stop: StopOutcome;
  found: FoundResource[];
  /** Что не прочиталось: такой снимок «пусто» не значит (F25). */
  unread: string[];
  /**
   * Защищённые корни против снимка до шага (P04): каждая находка уже в журнале сигналом `stop`,
   * шаг останавливает вызывающий; `unknown` — корень не прочитан, «не изменилось» не сказано.
   */
  protectedRoots: Fact<ProtectedRootFinding[]>;
}

export interface RoadSession {
  done: Promise<void>;
  detach(): void;
  /** Остановить сессию: порты дерева до остановки, остальное после — в журнал задачи. */
  end(mode: StopMode): Promise<SessionEnd>;
}

export interface TaskRelease {
  verified: { rid: string; fact: string }[];
  leaks: { rid: string; reason: string }[];
  /**
   * Снимки конца шага, которые не прочитались (сигнал `resources-unread` в журнале, ревью
   * A2r5-F05): находок по ним нет, но и «утечек нет» над ними не сказано (F25).
   */
  unread: { sessionId: string; reason: string }[];
}
