import type { ProviderStatus } from './providers';

/**
 * Детект установленных провайдер-CLI (Ф7).
 *
 * Панель определяет, какие CLI реально стоят в системе, и показывает это в
 * селекторе провайдера + в лёгком онбординге. Детект — ПОДСКАЗКА, а не
 * принуждение: дефолт остаётся `claude`, автопереключения провайдера нет.
 *
 * Что именно проверяется (и чего НЕ делается):
 * - `cliInstalled` — бинарь найден в PATH (`where` на Windows / `which` на POSIX);
 * - `configPresent` — существует каталог или файл конфигурации провайдера
 *   (только `existsSync` — СОДЕРЖИМОЕ не читается, секреты не трогаются);
 * - версия НЕ определяется: `--version` не спавнится, чтобы исключить любые
 *   зависания и интерактивные приглашения чужих CLI.
 */

/** Результат детекта по одному провайдеру. */
export interface ProviderDetection {
  id: string;
  name: string;
  status: ProviderStatus;
  /** Имя команды CLI под текущую ОС (`claude` / `claude.cmd`). */
  cliCommand: string;
  /** Бинарь CLI найден в PATH. */
  cliInstalled: boolean;
  /** Найден каталог/файл конфигурации провайдера (содержимое не читалось). */
  configPresent: boolean;
  /**
   * Пути, которые проверялись на существование, — для подсказки в интерфейсе.
   * Пусто у провайдера, у которого расположение конфигурации не задокументировано
   * (fail-closed: не угадываем).
   */
  configPaths: string[];
}

/** Ответ `GET /api/providers/detect`: активный провайдер + детект по всем известным. */
export interface ProviderDetectResponse {
  active: string;
  providers: ProviderDetection[];
}
