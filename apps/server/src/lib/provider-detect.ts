import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type {
  AppSettings,
  ProviderDetectResponse,
  ProviderDetection,
} from '@claude-control/contracts';
import { getActiveProviderId, listProviders } from '../providers/registry.ts';
import { providerCliCandidates, providerCliCommand } from '../providers/cli.ts';
import type { ConfigProvider } from '../providers/types.ts';

/**
 * Детект установленных провайдер-CLI (Ф7) — ОБЩИЙ хелпер.
 *
 * Отвечает на два вопроса по каждому провайдеру: стоит ли его бинарь в системе
 * (`cliInstalled`) и есть ли у него каталог/файл конфигурации (`configPresent`).
 * Результат — ПОДСКАЗКА интерфейсу: селектор рисует бейджи, онбординг перечисляет
 * найденные CLI. Дефолтный провайдер (`claude`) детект НЕ меняет и автоматически
 * ничего не переключает.
 *
 * БЕЗОПАСНОСТЬ И ОТСУТСТВИЕ ЗАВИСАНИЙ:
 * - `--version` НЕ спавнится: чужие CLI могут спросить что-то интерактивно или
 *   уйти в сеть, поэтому версию не определяем вовсе (и по умолчанию она выключена
 *   как понятие — в ответе её нет);
 * - `where`/`which` вызываются с таймаутом и `stdio: 'ignore'`, любая ошибка
 *   (нет такой команды, отказ прав, таймаут) трактуется как «не найдено» — детект
 *   НИКОГДА не роняет сервер;
 * - конфигурация проверяется только `existsSync`: содержимое не читается, значит
 *   ничьи секреты не затрагиваются; записи нет вообще.
 *
 * Детект CLI и проверка путей инъектируются (`DetectDeps`) — тесты подменяют их и
 * не зависят от реально установленных на машине инструментов.
 */

/** Сколько ждём `where`/`which`, прежде чем считать, что бинаря нет. */
const LOOKUP_TIMEOUT_MS = 4000;

/**
 * Кроссплатформенный детект бинаря CLI в PATH через `where` (Windows) / `which`
 * (POSIX). Обёрнут так, чтобы НИКОГДА не падать: любая ошибка/таймаут → `false`.
 *
 * Общий для всей панели: им же резолвится раннер ассистента
 * (`domains/provider-keys.ts`) — второй реализации детекта в коде нет.
 */
export function detectCliOnPath(command: string): boolean {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    // Вывод НЕ разбираем (`stdio: 'ignore'`) — смотрим только код возврата.
    // Это важно именно на Windows: `where claude.cmd` вполне может напечатать
    // НЕСКОЛЬКО строк (одна и та же команда в нескольких каталогах PATH — глобальный
    // npm, nvm, Scripts). Разбор «первой строки» дал бы ложные ветвления; нам же
    // нужен один факт «нашлось или нет», а запуск всё равно идёт по имени, а не по
    // добытому пути, — то есть ту же строку разрешит сама ОС.
    const result = spawnSync(finder, [command], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: LOOKUP_TIMEOUT_MS,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Первое из имён-кандидатов, найденное в PATH (или `undefined`). На Windows это
 * `<name>.cmd` → `<name>`: инструмент мог быть поставлен и npm-обёрткой, и как
 * .exe (см. `providerCliCandidates`). `detect` инъектируется для тестов.
 */
export function findCliOnPath(
  candidates: string[],
  detect: (command: string) => boolean = detectCliOnPath,
): string | undefined {
  return candidates.find((candidate) => detect(candidate));
}

/** Существует ли путь. Любая ошибка ФС → `false` (детект не должен падать). */
export function pathExists(target: string): boolean {
  try {
    return existsSync(target);
  } catch {
    return false;
  }
}

/** Подменяемые зависимости детекта — чтобы тест не зависел от реальной машины. */
export interface DetectDeps {
  detectCli?: (command: string) => boolean;
  exists?: (path: string) => boolean;
}

/** Минимум настроек, нужный детекту (без импорта AppStore). */
export interface DetectSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/**
 * Детект одного провайдера. `override` — пользовательский каталог конфигурации
 * (его уважает только Claude). Провайдер без `configLocations` →
 * `configPresent: false` и пустой список путей: расположение не задокументировано,
 * и панель его не угадывает (fail-closed).
 */
export function detectProvider(
  provider: ConfigProvider,
  override?: string,
  deps: DetectDeps = {},
): ProviderDetection {
  const detectCli = deps.detectCli ?? detectCliOnPath;
  const exists = deps.exists ?? pathExists;
  // На Windows проверяем оба имени (`codex.cmd`, затем `codex`): CLI ставится и
  // npm-обёрткой, и нативным .exe. Показываем то имя, которое реально нашлось, —
  // им же панель и запускается. Ничего не нашлось → показываем имя по умолчанию.
  const found = findCliOnPath(providerCliCandidates(provider), detectCli);
  const cliCommand = found ?? providerCliCommand(provider);

  // Пути считаем в try: у Claude они резолвятся детектом расположения, который
  // на битом override может бросить — детект от этого падать не должен.
  let configPaths: string[];
  try {
    configPaths = provider.configLocations?.(override) ?? [];
  } catch {
    configPaths = [];
  }

  return {
    id: provider.id,
    name: provider.name,
    status: provider.status,
    cliCommand,
    cliInstalled: found !== undefined,
    configPresent: configPaths.some((path) => exists(path)),
    configPaths,
  };
}

/**
 * Детект по ВСЕМ известным провайдерам (Claude первым) + id активного —
 * полезная нагрузка `GET /api/providers/detect`. Операция дешёвая (несколько
 * `where`/`which` и `existsSync`), поэтому кеша нет: ответ всегда актуален,
 * например сразу после установки CLI.
 */
export function detectProviders(
  store: DetectSettingsSource,
  deps: DetectDeps = {},
): ProviderDetectResponse {
  const override = store.getSettings().claudeDirOverride;
  return {
    active: getActiveProviderId(store),
    providers: listProviders().map((provider) => detectProvider(provider, override, deps)),
  };
}
