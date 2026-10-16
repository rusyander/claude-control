/**
 * Питание машины с панелью: что можно сделать с ней удалённо — гибернация или
 * сон — и что из этого есть на этой системе.
 *
 * Выключить совсем панель не умеет намеренно: включить машину обратно телефон
 * не может, а гибернация и сон хотя бы сохраняют открытое — окна, папки, файлы.
 */

/**
 * Действие. `hibernate` — память на диск, питание выключено (Windows, Linux с
 * настроенной гибернацией). `sleep` — сон: на macOS `pmset sleepnow`, на Linux
 * `systemctl suspend`.
 */
export type PowerAction = 'hibernate' | 'sleep';

/**
 * Почему действия нет: `disabled` — выключено в системе (на Windows —
 * `powercfg /hibernate on` от администратора); `not-allowed` — система не даёт
 * его без пароля или не поддерживает; `no-tool` — нет нужной утилиты (`busctl`,
 * `pmset`); `unsupported` — платформа не из трёх известных.
 */
export type PowerUnavailableReason = 'disabled' | 'not-allowed' | 'no-tool' | 'unsupported';

export interface PowerOption {
  action: PowerAction;
  available: boolean;
  reason?: PowerUnavailableReason;
}

/** Итог прошлой попытки, если команда системы отказала уже после ответа телефону. */
export interface PowerFailure {
  action: PowerAction;
  at: string;
  message: string;
}

export interface PowerStatus {
  platform: 'win32' | 'darwin' | 'linux' | 'other';
  /** Варианты в порядке предпочтения: первый доступный — то, что предложит кнопка. */
  options: PowerOption[];
  /**
   * macOS: `hibernatemode` из `pmset -g`. 0 — обычный сон (память под питанием),
   * 3 — сон с копией памяти на диске (переживает разряд батареи), 25 — настоящая
   * гибернация. На других системах нет.
   */
  macHibernateMode?: number;
  /** Идёт локальный прогон и держит запрет на сон — уснув, машина его остановит. */
  awakeHeld: boolean;
  lastFailure?: PowerFailure;
}

/** Тело запроса: действие и явное «да» — случайный POST машину не усыпит. */
export interface PowerRequest {
  action: PowerAction;
  confirm: true;
}

/** Ответ на запрос: машина уйдёт через `inMs` — ответ успевает дойти до телефона. */
export interface PowerAccepted {
  action: PowerAction;
  inMs: number;
}

/**
 * Кто эта машина — часть ответа `/api/system`. Телефон, спаренный с несколькими
 * панелями, подписывает компьютер именем и узнаёт его по номеру, даже когда
 * адрес сменился (другой порт, Tailscale вместо локальной сети).
 */
export interface MachineIdentity {
  platform: string;
  machineName: string;
  machineId: string;
}
