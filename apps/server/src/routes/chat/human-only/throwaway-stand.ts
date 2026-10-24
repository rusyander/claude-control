import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * Одноразовый стенд проверки: каталог данных панели И каталог конфигурации
 * Claude — оба во временном каталоге ОС (решение координатора 24.10, после
 * RF-DS-04/05).
 *
 * Зачем. Ворота «решает только человек» отбивают браузер под Playwright и сам
 * процесс проверки — а живые проверки панели (`tools/qa/*`) решают карточки и
 * D-n именно так. На одноразовом стенде это безопасно пропустить: его решение
 * не дотянется ни до прогонов и D-n настоящей панели (они в её процессе и её
 * каталоге данных), ни до настоящего `~/.claude` (конфигурация стенда — в temp).
 *
 * Почему не флаг и не переменная. Перезапустить панель может и сам агент. Флаг
 * или переменная окружения открыли бы шов на НАСТОЯЩЕЙ панели. Поэтому корень
 * temp берётся не из `TEMP`/`TMP`/`TMPDIR` и не из `os.homedir()` (оба из
 * окружения), а из учётной записи ОС: `os.userInfo().homedir` — профиль по
 * токену процесса (Windows) или по `passwd` (POSIX). Пути разрешаются
 * (`realpath`): соединение каталогов из temp на настоящий `~/.claude` ведёт за
 * пределы temp и шва не открывает.
 *
 * Чего это не закрывает: агент, который сам скопирует каталоги панели в temp и
 * перезапустит её там, уже владеет данными стенда — записать «разрешено» в файл
 * копии он мог бы и без HTTP (остаток RF-DS-07/08, назван в отчёте).
 */

export interface PanelDirs {
  /** Каталог конфигурации Claude (`location.paths.root`). */
  config: string;
  /** Каталог данных панели (`location.paths.appData`). */
  data: string;
}

function real(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/** Корни temp ОС, не зависящие от окружения процесса. */
export function osTempRoots(platform: string = process.platform): string[] {
  let raw: string[];
  if (platform === 'win32') {
    let home: string | undefined;
    try {
      home = userInfo().homedir;
    } catch {
      home = undefined;
    }
    raw = home ? [win32.join(home, 'AppData', 'Local', 'Temp')] : [];
  } else if (platform === 'darwin') {
    raw = ['/private/tmp', '/private/var/folders'];
  } else {
    raw = ['/tmp', '/var/tmp'];
  }
  return raw.map((dir) => real(dir)).filter((dir): dir is string => Boolean(dir));
}

function under(path: string, root: string, platform: string): boolean {
  const paths = platform === 'win32' ? win32 : posix;
  const norm = (value: string) => {
    const plain = paths.normalize(value).replace(/[\\/]+$/, '');
    return platform === 'win32' ? plain.toLowerCase() : plain;
  };
  const file = norm(path);
  const dir = norm(root);
  return file !== dir && file.startsWith(`${dir}${paths.sep}`);
}

/**
 * Путь каталога, которого может не быть: `..` сворачивается сразу, ближайший
 * существующий предок разрешается (соединение наружу видно здесь), пропавший
 * хвост дописывается как есть — в нём ссылок нет, раз его нет на диске.
 */
function realOrAncestor(path: string, platform: string): string | undefined {
  const paths = platform === 'win32' ? win32 : posix;
  const tail: string[] = [];
  let current = paths.resolve(path);
  for (;;) {
    const resolved = real(current);
    if (resolved) return paths.join(resolved, ...tail.reverse());
    const parent = paths.dirname(current);
    if (parent === current) return undefined;
    tail.push(paths.basename(current));
    current = parent;
  }
}

/**
 * Одноразовый ли стенд: оба каталога по разрешённому пути лежат внутри корня
 * temp ОС. Каталог данных обязан существовать — его заводит сама панель. Каталога
 * конфигурации может не быть: стенд «машина без Claude Code» (`noClaude`) проверяет
 * как раз то, что `~/.claude` не появляется, а без шва ворота отбивали бы его
 * мастер первого запуска (`PATCH /api/settings`). Пропавший каталог судится по
 * разрешённому предку: путь, ведущий за temp, шва не открывает.
 */
export function isThrowawayStand(
  dirs: PanelDirs | undefined,
  roots: readonly string[] = osTempRoots(),
  platform: string = process.platform,
): boolean {
  if (!dirs || roots.length === 0 || !dirs.config || !dirs.data) return false;
  const resolved = [realOrAncestor(dirs.config, platform), real(dirs.data)];
  return resolved.every(
    (dir) => Boolean(dir) && roots.some((root) => under(dir as string, root, platform)),
  );
}

/**
 * Имена программ браузеров, которые запускает автоматизация (Playwright, свои
 * сборки и безоконная оболочка). Доверие по ИМЕНИ — только на одноразовом
 * стенде; на настоящей панели браузер узнаётся по установке и ключам запуска.
 */
const AUTOMATION_BROWSER =
  /^(?:chrome|chromium|chromium-browser|msedge|firefox|chrome-headless-shell|headless_shell|google chrome(?: for testing)?(?: helper.*)?|chromium helper.*|microsoft edge(?: helper.*)?)(?:\.exe)?$/i;

export function isAutomationBrowserName(name: string): boolean {
  return AUTOMATION_BROWSER.test(name.trim());
}
