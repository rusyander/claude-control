import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CaptureAnswer,
  CaptureResult,
  CheckEntryRoad,
  RecordOrigin,
} from '@agentdeck/contracts/core/records';
import type { TaskRegistry } from '../conductor/tasks.ts';
import type { PseudoTasks } from '../policy/session-tokens/pseudo-tasks.types.ts';
import type { SessionTokens } from '../policy/session-tokens/session-tokens.ts';

/**
 * Вопрос захвата, как его получает единственный вход проверок (G21: `requestCheck` зоны C).
 * Задача и шаг — от токена (сессия) или от предка-CLI (псевдозадача), никогда из тела запроса.
 */
export interface CaptureCheckAsk {
  road: Extract<CheckEntryRoad, 'capture-preload' | 'capture-wrapper' | 'pseudo'>;
  origin: Extract<RecordOrigin, 'session' | 'pseudo'>;
  taskId: string;
  sessionId: string | null;
  stepId: string | null;
  /** argv, который исполнится (03:126): ключ считается от него, а не от текста команды. */
  argv: string[];
  cwd: string;
  envDigest: string;
  /** Значения имён прокладки (`null` — не задана): ключ прогона вызывающего считается от его окружения. */
  env: Record<string, string | null>;
  caller: { pid: number; pidStart: number };
}

/** Чей итог: под чьим доступом он пришёл (аренда сессии проверяется против её задачи). */
export interface CaptureResultOwner {
  origin: CaptureCheckAsk['origin'];
  taskId: string | null;
}

/**
 * Порт ко входу проверок (волна 2: `conductor/checks.requestCheck` с `exec:'caller'`). Ответ —
 * уже вид прокладки: повтор | прогон под арендой | сужение | отказ | насквозь.
 */
export interface CaptureEntry {
  ask(ask: CaptureCheckAsk): Promise<CaptureAnswer>;
  result(
    owner: CaptureResultOwner,
    result: CaptureResult,
  ): Promise<{ taken: true } | { refused: string }>;
}

export interface SessionCaptureDeps {
  registry: TaskRegistry;
  tokens: SessionTokens;
  /** `<дом ядра>/capture-token`, читается на каждом запросе (снятая установка — сразу без доступа). */
  captureToken(): Fact<string>;
  /** Нет входа проверок — 503 `check-entry-absent`: прокладка прогоняет сама и кладёт итог в очередь. */
  entry?: CaptureEntry;
  /** Нет — вопрос с доступом захвата идёт насквозь, названный «вне очереди». */
  pseudo?: PseudoTasks;
  /** Ленивый забор очереди `spool/` перед ответом. */
  drainSpool?: () => Promise<unknown>;
  note?: (event: string, data: Record<string, unknown>) => void;
}
