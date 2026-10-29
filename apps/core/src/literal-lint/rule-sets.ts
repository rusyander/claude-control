import type { LiteralRuleSet } from './literal-lint.ts';
import { P108_CLI_NAMES } from './p108.ts';

/**
 * Наборы литерального линта — чистые данные: механизм в `literal-lint.ts` один, свойство
 * добавляется новым набором здесь (P108 — список имён из модуля реестра, превращённый в
 * правила). Пути — от `apps/core/src`, через `/`.
 *
 * Сообщения пишутся без самих запрещённых литералов: этот файл проходит свои же наборы
 * (папка `literal-lint/` не исключена), и строка сообщения — тоже строка.
 */

/** Тесты и подставные процессы знают, на какой ОС идут, — им это разрешено. */
const TEST_FILES = ['\\.test\\.ts$', '(^|/)__fixtures__/'];

/** Кавычка любого вида — указатель модуля и ключ по индексу видны в `code` с кавычками. */
const Q = '[\'"`]';

/** Обращение к члену: `.x`, `?.x`, `['x']`, `?.['x']` (F-81: индексная форма обходила линт). */
function member(names: string): string {
  return `(?:\\s*\\??\\.\\s*(?:${names})\\b|\\s*(?:\\?\\.)?\\[\\s*${Q}(?:${names})${Q}\\s*\\])`;
}

/**
 * Модуль целиком: привычное имя, имя, под которым ЭТОТ файл привязал модуль (`<<…>>`, F-81:
 * `import * as o`, `const o = require(…)`, `const o = await import(…)`), или сама загрузка —
 * `require('os').x`, `(await import('node:os')).x`.
 */
function moduleRef(module: string, names: string): string {
  const load = `\\b(?:require|import)\\s*\\(\\s*${Q}(?:node:)?${module}${Q}\\s*\\)\\s*\\)?`;
  return `(?:\\b(?:${names}<<${module}>>)\\b|${load})`;
}

/** `{ … имя … } = <модуль>` — деструктуризация, в том числе из `await import(…)` и `require(…)`. */
function destructured(names: string, ref: string): string {
  return `\\{[^{}]*\\b(?:${names})\\b[^{}]*\\}\\s*=\\s*\\(?\\s*(?:await\\s+)?${ref}`;
}

/** Именованный импорт или реэкспорт из модуля (псевдоним `{ x as y }` несёт исходное имя). */
function namedImport(names: string, module: string): string {
  return `\\b(?:import|export)\\s+(?:type\\s+)?\\{[^}]*\\b(?:${names})\\b[^}]*\\}\\s*from\\s*${Q}(?:node:)?${module}${Q}`;
}

/** Что у node os отвечает на вопрос «какая ОС» и «где дом». */
const OS_MEMBERS = 'platform|type|EOL|homedir|userInfo';
const OS_REF = moduleRef('os', 'os|nodeOs');
const PROCESS_REF = moduleRef('process', 'process');
const PATH_REF = moduleRef('path', 'path');
/** Вид пути и разделители: `sep` и `delimiter` у Windows и POSIX разные. */
const PATH_FLAVOURS = 'win32|posix|sep|delimiter';
/** Переменные дома и профиля: Windows, POSIX и XDG-каталоги (F-81: последние две группы обходили). */
const HOME_VARS = 'USERPROFILE|APPDATA|LOCALAPPDATA|HOME|HOMEPATH|HOMEDRIVE|XDG_[A-Z0-9_]+';

/** P51 (09-platforms §Properties, R:S3-24): развилка по ОС — только в `platform/`. */
export const P51_OS_BRANCH: LiteralRuleSet = {
  id: 'P51',
  spec: '09-platforms, no OS branch outside platform/',
  allowed: ['platform'],
  exempt: TEST_FILES,
  rules: [
    {
      id: 'process-platform',
      in: 'code',
      pattern: `${PROCESS_REF}${member('platform')}`,
      message: 'the OS kind comes from platform/os-kind (currentOs), not from the process object.',
    },
    {
      id: 'process-platform-destructured',
      in: 'code',
      pattern: destructured('platform', PROCESS_REF),
      message:
        'the OS kind comes from platform/os-kind, not from destructuring the process object.',
    },
    {
      id: 'process-platform-import',
      in: 'code',
      pattern: namedImport('platform', 'process'),
      message: 'the OS kind comes from platform/os-kind, not from the process module.',
    },
    {
      id: 'os-member',
      in: 'code',
      pattern: `${OS_REF}${member(OS_MEMBERS)}`,
      message: 'OS name, type, line ending and home come from platform/, not from node os.',
    },
    {
      id: 'os-destructured',
      in: 'code',
      pattern: destructured(OS_MEMBERS, OS_REF),
      message: 'OS name, type, line ending and home come from platform/, not from node os.',
    },
    {
      id: 'os-import',
      in: 'code',
      pattern: namedImport(OS_MEMBERS, 'os'),
      message: 'OS name, type, line ending and home come from platform/, not from node os.',
    },
    {
      id: 'path-flavour',
      in: 'code',
      pattern: `${PATH_REF}${member(PATH_FLAVOURS)}`,
      message: 'path flavour belongs to platform/paths.',
    },
    {
      id: 'path-flavour-destructured',
      in: 'code',
      pattern: destructured(PATH_FLAVOURS, PATH_REF),
      message: 'path flavour belongs to platform/paths.',
    },
    {
      id: 'path-flavour-import',
      in: 'code',
      pattern: namedImport(PATH_FLAVOURS, 'path'),
      message: 'path flavour belongs to platform/paths.',
    },
    {
      id: 'path-flavour-module',
      in: 'code',
      pattern: `${Q}(?:node:)?path/(?:win32|posix)${Q}`,
      message: 'path flavour belongs to platform/paths, not to a flavoured path module.',
    },
    {
      id: 'home-env-member',
      in: 'code',
      pattern: `\\.\\s*(?:${HOME_VARS})\\b`,
      message: 'home and profile folders come from platform/ (os-kind homeDir).',
    },
    {
      id: 'home-env-destructured',
      in: 'code',
      pattern: `\\{[^{}]*\\b(?:${HOME_VARS})\\b[^{}]*\\}\\s*=\\s*${PROCESS_REF}\\s*\\.\\s*env\\b`,
      message: 'home and profile folders come from platform/ (os-kind homeDir).',
    },
    {
      id: 'home-env-name',
      in: 'strings',
      pattern: `^(?:${HOME_VARS})$`,
      message: 'home and profile variable names are known only to platform/.',
    },
    {
      id: 'windows-suffix',
      in: 'strings',
      pattern: '\\.(exe|cmd|ps1)\\b',
      flags: 'i',
      message: 'Windows executable suffixes are resolved by platform/ (exec-resolve, win-shim).',
    },
    {
      id: 'crlf',
      in: 'strings',
      pattern: '\\r\\n',
      message: 'line endings are written by platform/encoding.',
    },
  ],
};

export const LITERAL_RULE_SETS: readonly LiteralRuleSet[] = [P51_OS_BRANCH, P108_CLI_NAMES];
