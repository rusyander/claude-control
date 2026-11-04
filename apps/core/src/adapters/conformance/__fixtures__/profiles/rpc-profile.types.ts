import type { SessionSpec } from '../../../adapter.types.ts';
import type { RpcDump } from '../rpc-replay.ts';
import type { RpcAdapter, RpcAdapterOptions } from '../../../rpc-stdio/rpc-adapter.ts';

/**
 * Профиль переходника JSON-RPC по stdio (Codex `app-server`, ACP Goose и OpenCode) для набора
 * соответствия: записи живого CLI (`record-<cli>.ts` → `<cli>/__fixtures__/<name>.jsonl`)
 * проигрывает `replay-rpc.mjs`. Форма своя: у таких CLI нет argv-флагов прав и файлов настроек
 * Claude — профиль SDK к ним не подходит. Право спрашивается строкой протокола (`in-band`).
 */
/**
 * Продолжение разговора для набора соответствия (`caps.resume`): метод протокола и поле id в его
 * параметрах, разговор этого CLI в доме прежней сессии ядра, подложный id той же формы.
 */
export interface ResumeProfile {
  method: string;
  idParam: string;
  /** Кладёт разговор корня `cwd` в дом прежней сессии ядра `priorDir`; возвращает его id. */
  seed(priorDir: string, cwd: string): string;
  /** Id формы этого CLI, которого в доме нет. */
  forged: string;
}

export interface RpcProfile {
  /** Продолжение разговора — у переходника с `caps.resume`. */
  resume?: ResumeProfile;
  id: string;
  make(options: RpcAdapterOptions): RpcAdapter;
  command: string;
  endpoint: SessionSpec['endpoint'];
  fixtures: {
    /** Два хода текстом подряд (`FIRST_TURN` → `ANSWER_ONE`, `SECOND_TURN` → `ANSWER_TWO`). */
    basic: string;
    /** Вызов команды под вопросом о праве; ответ «да» → `PERMIT_DONE`. */
    permit: string;
    /** Хук ядра отказал команде (`git push`); модель видит отказ → `BLOCKED_SEEN`. */
    blocked: string;
  };
  /** Команда хука ядра, как её запишет переходник для этого сеанса (ключ подмены записи). */
  hookCommand(spec: SessionSpec): string;
  /** Команды хуков перед вызовом инструмента из файла сеанса. */
  hookCommands(dir: string): string[];
  /** Серверы MCP, которые сеанс отдал CLI: файл сеанса (`dir`) или строка протокола (дамп). */
  mcpNames(dump: RpcDump, dir: string): string[];
  /**
   * Метод протокола, которым клиент доверяет хуку (должен уйти до начала треда). Нет — CLI хук
   * из файла сеанса берёт сам, без доверия по протоколу (ACP): случаи доверия не идут.
   */
  trustMethod?: string;
  /** Метод начала треда — после доверия хуку и никогда без него. */
  threadMethod: string;
  /** Имя вызова оболочки в событии `tool.requested`, как его видит журнал ядра. */
  shellTool: string;
  /** Часть ответа клиента на вопрос о праве, когда ядро разрешило вызов один раз. */
  permitReply: Record<string, unknown>;
  /**
   * Что видно, когда хук ядра отказал: `nothing` — ни результата, ни вопроса о праве (хук раньше
   * вопроса, отказ без итога вызова); `failed` — итог вызова ошибкой (вопрос мог прийти раньше
   * хука: запись на него ответила «да», отказ всё равно держится).
   */
  blockedShows: 'nothing' | 'failed';
}
