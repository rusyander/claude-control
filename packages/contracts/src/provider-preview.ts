import type { DiffLine } from './history';

/**
 * Предпросмотр записи в конфигурацию чужого CLI (IDEA-10).
 *
 * Панель правит файлы, которые человек до неё вёл руками, и «сохранить» в чужом
 * формате — шаг с закрытыми глазами: непонятно, что именно окажется в файле и
 * не заденет ли это соседние ключи. Предпросмотр показывает ровно тот текст,
 * который будет записан, ДО записи — построчным диффом против нынешнего файла.
 *
 * Считается он честно: панель выполняет настоящую операцию адаптера, но на
 * ВРЕМЕННОЙ КОПИИ файла (тот же приём, что у проверки провайдера). То есть это
 * не «предсказание», а результат — просто ещё не примененный к вашему файлу.
 */

/** Раздел, для которого считается предпросмотр. */
export type ProviderPreviewSection = 'mcp' | 'permissions' | 'env' | 'instructions';

/** Что именно собираются сделать. Для всех разделов кроме MCP — `save`. */
export type ProviderPreviewAction = 'save' | 'upsert' | 'delete';

export interface ProviderPreviewRequest {
  section: ProviderPreviewSection;
  action?: ProviderPreviewAction;
  /** MCP: прежнее имя сервера при переименовании; `null`/пусто — новый сервер. */
  serverId?: string | null;
  /** Черновик в точности той формы, которую примет маршрут записи. */
  draft?: unknown;
}

export interface ProviderPreviewResponse {
  providerId: string;
  providerName: string;
  /** Файл, который будет изменён. */
  filePath: string;
  /** Файл уже существует (иначе запись его создаст). */
  exists: boolean;
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Запись ничего не изменит — тогда диалог честно об этом говорит. */
  unchanged: boolean;
  /**
   * Файл слишком велик для построчного сравнения: дифф не строился, `lines`
   * пуст. Лучше сказать прямо, чем показать обрезанный кусок как полную картину.
   */
  truncated: boolean;
}
