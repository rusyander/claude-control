import type { OurLayerId, OurRules, Platform, PlatformRunLayers } from '@agentdeck/contracts';
import { posix, win32 } from 'node:path';
import { defaultOurRules } from '@agentdeck/contracts/platform';

/**
 * НАШИ слои в прогоне через контур (Т8): что из `~/.claude` едет в запуск.
 *
 * Чистый модуль, как и матрица правил Т7: ни сети, ни хранилища, ни знания о
 * том, чем запускают CLI. Отсюда берут и флаги запуска, и строку следа, и
 * подписи карточки — один расчёт на три места, потому что разошлись бы они
 * молча, а человек читал бы на экране «скиллы сняты» при полном промпте.
 *
 * ПОЧЕМУ СЛОЙ СНИМАЕТСЯ ФЛАГОМ, А НЕ СОБРАННЫМ КАТАЛОГОМ. Первым планом Т8 был
 * одноразовый `CLAUDE_CONFIG_DIR` с копией только нужных слоёв. Он отменён
 * пробой: транскрипт разговора Claude Code пишет ВНУТРЬ каталога конфигурации
 * (проверено — `<каталог>/projects` появляется при каждом запуске), а панель
 * читает переписку ровно из одного места (`location.paths.projects`). Подменив
 * каталог, панель получила бы чат, которого нет в списке, которого не продолжить
 * (`--resume` ищет сессию там же) и который не виден ни поиску, ни аналитике.
 * Поэтому каталог остаётся настоящим, а слои снимаются флагами запуска — и
 * ключей в собранный каталог не копируется, потому что каталога нет вовсе.
 *
 * ЧТО КАКОЙ ФЛАГ СНИМАЕТ — ЗАМЕРЕНО, А НЕ ПРОЧИТАНО В СПРАВКЕ. Проба
 * `.agent/tmp/t8-layers-probe.mjs` (настоящий `claude` 2.1.263, стаб вместо
 * модели, метки каждого слоя ищутся в теле запроса наверх):
 *   `--setting-sources project,local` — уносит личные правила, хуки, права,
 *      личные скиллы и личные MCP-серверы разом: в CLI это один источник
 *      `user`. Проектный слой (CLAUDE.md, `.claude/skills`, `.mcp.json`) этот
 *      флаг НЕ трогает;
 *   `--disable-slash-commands` — скиллы и сам инструмент `Skill`, причём ВСЕ,
 *      включая скиллы репозитория (это НЕ то же самое, что источник `user`:
 *      встроенные скиллы уходят только так);
 *   `--strict-mcp-config` — ВСЕ MCP-серверы, кроме приехавших своим
 *      `--mcp-config`: и личные, и проектный `.mcp.json`, и переходник панели к
 *      контуру. Переживает его только брокер прав панели.
 * Последние два — не придирка к формулировке, а ревью Т8 (MAJOR-1, MAJOR-2):
 * галочки уносят инструменты и скиллы САМОЙ ЗАДАЧИ, и раз раздельного флага у
 * CLI нет, это сказано словами у каждой галочки, а не спрятано. Брокер прав
 * держится ровно на том, что панель везёт его своим `--mcp-config` (порядок
 * флагов при этом безразличен — проверено настоящим CLI в обоих порядках);
 * снеси этот флаг — и каждый запрос прав стал бы молчаливым отказом посреди
 * работы агента.
 */

/** Форму держит контракт: её читает и карточка (`PlatformStatus.layers`). */
export type RunLayers = PlatformRunLayers;

/**
 * Действует ли слой. Общий выключатель сильнее частных: снятый, он означает
 * «ни одного нашего слоя», и частная галочка его не переспорит.
 */
export function layerOn(rules: OurRules, layer: OurLayerId): boolean {
  return rules.enabled && rules[layer];
}

/** Слои этого контура для прогона Claude. */
export function runLayers(platform: Platform): RunLayers {
  return layersOf(platform.rules.ours, true);
}

/**
 * Лёгкое окно агента панели (решение владельца 3): ни одного нашего слоя — теми
 * же флагами, что и снятые галочки контура, а не своим списком рядом, — и
 * вдобавок без проектного источника.
 *
 * ПОЧЕМУ ЕЩЁ И ПРОЕКТ. Замерено 17.09.2026 настоящим `claude` 2.1.263 против
 * стаба (`tools/qa/check-run-layers.mjs`, случай «агент панели»): с
 * `--setting-sources project,local` личный `CLAUDE.md` из каталога конфигурации
 * до запроса НЕ доезжает, а `~/.claude/CLAUDE.md` доезжает всё равно — CLI
 * ищет `CLAUDE.md` и `.claude/CLAUDE.md` вверх от рабочего каталога, а временная
 * папка агента лежит под домашним каталогом, и тот же файл читается как правила
 * ПРОЕКТА `~`. Уносит его только источник `project`: у агента проекта нет
 * (рабочий каталог — пустая временная папка), значит, снимать нечего, кроме
 * чужих правил. `CLAUDE_CODE_DISABLE_CLAUDE_MDS` делает то же, но его нет в
 * справке CLI, а `--safe-mode` уносит и переходник панели — оба отвергнуты той
 * же пробой.
 */
export function lightWindowLayers(): RunLayers {
  return layersOf({ ...defaultOurRules(), enabled: false }, false);
}

/** Где запускается CLI — ровно то, из чего он сам соберёт пути правил. */
export interface UserMemoryPlace {
  /** Рабочий каталог прогона в том написании, в каком его получит процесс. */
  cwd: string;
  /** Окружение процесса CLI целиком (дом и каталог конфигурации берутся из него). */
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** Дом, если окружение его не называет (`os.homedir()` панели). */
  fallbackHome: string;
}

/**
 * Личный `CLAUDE.md`, который CLI читает КАК ПРОЕКТНЫЙ, — исключить его при
 * снятом слое личных настроек. Возвращает текст файла для `--settings` или
 * `undefined`, когда исключать нечего.
 *
 * ПОЧЕМУ `--setting-sources project,local` МАЛО. Замерено 17.09.2026 настоящим
 * `claude` 2.1.263 против стаба (`check-run-layers.mjs`, случай 8): CLI ищет
 * `CLAUDE.md` и `.claude/CLAUDE.md` вверх от рабочего каталога, и у проекта под
 * `~` файл `~/.claude/CLAUDE.md` приезжает правилами ПРОЕКТА `~` — источник
 * `user` снят, а личные правила в запросе. Снять весь `project` нельзя: вместе с
 * ним ушёл бы `CLAUDE.md` монорепозитория над проектом, а это правила задачи.
 * Поэтому исключаются ровно личные файлы — настройкой `claudeMdExcludes`, которая
 * через `--settings` действует при любом `--setting-sources` (замерено тем же
 * прогоном; справка CLI говорит то же: «--settings still apply»).
 *
 * ПОЧЕМУ ШАБЛОН БЕЗ УЧЁТА РЕГИСТРА. CLI сравнивает исключение с путём,
 * построенным от рабочего каталога, и С УЧЁТОМ регистра, а какое написание он
 * увидит, панель не знает: через `cmd.exe` буква диска остаётся как передана, а
 * остальные части пути приводятся к настоящему регистру (`c:\Users\…` —
 * замерено), прямой запуск оставляет путь как есть. Поэтому на Windows и macOS
 * (регистронезависимые ФС) каждая буква шаблона — класс `[cC]`, а символы
 * шаблона — классы `[(]`: экранирование обратной чертой CLI на Windows читает
 * разделителем пути, и такой шаблон не срабатывает (замерено). Путь с `[`, `]`
 * или `!` класса не получает — остаётся буквальным. Буквальные написания
 * (от дома и от рабочего каталога, предки перебираются в его написании) идут
 * всегда: точное совпадение CLI узнаёт и без шаблона, и короткие имена `~1`
 * в рабочем каталоге ловит только оно.
 *
 * У лёгкого окна агента панели источника `project` нет вовсе
 * (`lightWindowLayers`), и функция честно отвечает «исключать нечего» — правило
 * одно на оба запуска, просто там его нечем применить.
 */
export function userMemorySettings(
  args: readonly string[],
  place: UserMemoryPlace,
): string | undefined {
  const at = args.indexOf('--setting-sources');
  if (at < 0) return undefined;
  const sources = (args[at + 1] ?? '').split(',');
  if (sources.includes('user') || !sources.includes('project')) return undefined;

  const win = place.platform === 'win32';
  const p = win ? win32 : posix;
  const home = (win ? place.env.USERPROFILE : place.env.HOME) || place.fallbackHome;
  const configDir = place.env.CLAUDE_CONFIG_DIR || p.join(home, '.claude');
  const key = (dir: string): string => {
    const clean = p.normalize(dir).replace(/[\\/]+$/, '');
    return win ? clean.toLowerCase() : clean;
  };

  const files = new Set<string>([
    p.join(configDir, 'CLAUDE.md'),
    p.join(home, '.claude', 'CLAUDE.md'),
  ]);
  let dir = p.normalize(place.cwd);
  for (;;) {
    if (key(dir) === key(home) || key(p.join(dir, '.claude')) === key(configDir)) {
      files.add(p.join(dir, '.claude', 'CLAUDE.md'));
    }
    if (key(dir) === key(configDir)) files.add(p.join(dir, 'CLAUDE.md'));
    const parent = p.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Прямые слэши на Windows: так шаблоны читает сам CLI (оба написания
  // срабатывают — замерено), а в JSON не двоятся обратные.
  const literal = [...files].map((file) => (win ? file.replaceAll('\\', '/') : file));
  const caseless = win || place.platform === 'darwin';
  const claudeMdExcludes = new Set(literal);
  if (caseless) for (const file of literal) claudeMdExcludes.add(caselessGlob(file));
  return JSON.stringify({ claudeMdExcludes: [...claudeMdExcludes] });
}

/** Шаблон пути без учёта регистра: `[cC]:/[uU]…`; см. `userMemorySettings`. */
function caselessGlob(path: string): string {
  if (/[[\]!]/.test(path)) return path;
  return [...path]
    .map((ch) => {
      if ('(){}*?+@'.includes(ch)) return `[${ch}]`;
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      return lower === upper || lower.length !== 1 || upper.length !== 1
        ? ch
        : `[${lower}${upper}]`;
    })
    .join('');
}

function layersOf(rules: OurRules, keepProject: boolean): RunLayers {
  const args: string[] = [];
  const dropped: OurLayerId[] = [];

  if (!layerOn(rules, 'settings')) {
    // compromise: rules-partial — правила, хуки и права уходят одним флагом: у CLI это один источник `user`
    // Именно `project,local`, а не пустая строка: проектный `CLAUDE.md` и
    // настройки репозитория — это правила ЗАДАЧИ, а не наши слои, и ЭТОТ флаг их
    // не трогает (замерено). Оговорка важна: два соседних флага ниже проектный
    // слой как раз уносят, и на карточке про них сказано отдельно.
    args.push('--setting-sources', keepProject ? 'project,local' : 'local');
    dropped.push('settings');
  }
  if (!layerOn(rules, 'skills')) {
    // Флаг снимает и скиллы репозитория: раздельного у CLI нет, и подпись
    // галочки говорит это вслух, а не обещает «только личные» (ревью Т8).
    args.push('--disable-slash-commands');
    dropped.push('skills');
  }
  if (!layerOn(rules, 'mcp')) {
    // Та же честность: уезжают и проектный `.mcp.json`, и переходник панели к
    // контуру, то есть инструменты самой задачи. Остаётся только брокер прав —
    // его панель везёт своим `--mcp-config` (ревью Т8).
    args.push('--strict-mcp-config');
    dropped.push('mcp');
  }
  const systemPrompt = layerOn(rules, 'systemPrompt');
  if (!systemPrompt) dropped.push('systemPrompt');

  return { args, systemPrompt, dropped };
}
