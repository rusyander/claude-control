/**
 * Вкладка «Логи» окна «Окружение»: вывод целей «Dev-сервера» и сервисов Docker
 * Compose проекта в одном месте.
 */

/** Откуда строки: цель запуска панели или сервис Compose (`*` — все сервисы). */
export type LogSourceKind = 'run' | 'compose';

export interface LogSource {
  /** `run:<dir>` (dir — подпапка цели, `.` для корня) или `compose:<service>` / `compose:*`. */
  id: string;
  kind: LogSourceKind;
  /** Имя цели или сервиса — как в «Dev-сервере» и на вкладке «Сервисы». */
  label: string;
  /**
   * Состояние источника: у цели — стадия запуска, у сервиса — состояние
   * контейнера. Строка, а не перечисление: значения двух миров разные.
   */
  state: string;
  /** Подсказка рядом с именем: команда цели или образ сервиса. */
  detail?: string;
}

export interface LogsSources {
  sources: LogSource[];
  /** Состояние docker: `missing`/`stopped` — сервисов Compose не спросить, сказано почему. */
  docker: 'ok' | 'missing' | 'stopped' | 'none';
  /** Файл Compose проекта, если найден. */
  composeFile?: string;
}

export interface LogLine {
  /** Время строки: у Compose — от docker, у цели — когда панель её получила. ISO. */
  at?: string;
  /** Поток у цели запуска; у Compose docker потоки не различает. */
  stream?: 'stdout' | 'stderr';
  /** Сервис строки — только у источника «все сервисы Compose». */
  service?: string;
  /** Текст строки без цветовых кодов. */
  text: string;
}

export interface LogsChunk {
  lines: LogLine[];
  /** Отдать при следующем опросе — придут только новые строки. */
  cursor?: string;
  /**
   * Начать с чистого листа: цель перезапустилась (вывод прежнего запуска
   * ушёл) или курсор не узнан.
   */
  reset?: boolean;
  /** Часть строк вытеснена буфером — показано не с самого начала. */
  truncated?: boolean;
  /** Источник есть в списке, но сейчас не пишет: цель остановлена, сервиса нет. */
  idle?: boolean;
}
