/**
 * argv одиночного запуска Continue (`cn -p`) — отдельно от каталога, потому что
 * здесь три решения, каждое из которых проверено живым `cn` 1.5.47
 * (`@continuedev/cli`), а не только по `--help`.
 *
 * 1. «Разрешить правки». В headless-режиме у `cn` инструменты правки (`Write`,
 *    `Edit`, `MultiEdit`) по умолчанию «ask» — а «ask» без человека их просто не
 *    показывает модели, — зато оболочка `Bash` разрешена, и файл пишется через
 *    неё. `--readonly` (plan-режим) оболочку тоже оставляет: живой прогон
 *    записал файл и с ним. Поэтому запрет — это `--exclude` всех четырёх (модель
 *    их не видит вовсе), а разрешение — `--allow` тех же четырёх. Флаги
 *    командной строки у `cn` стоят ВЫШЕ `permissions.yaml` человека, а `--auto`
 *    не берём: он отменяет и его запреты на всё остальное (MCP и прочее).
 *
 * 2. `--config` на собственный `config.yaml` человека. Без этого флага `cn -p`,
 *    увидев в окружении `ANTHROPIC_API_KEY`, ПЕРЕПИСЫВАЕТ `~/.continue/config.yaml`:
 *    дописывает две модели Claude с ключом открытым текстом (живой прогон
 *    06.10.2026). Панель наследует окружение человека, а у пользователя Claude
 *    этот ключ — обычное дело: каждый ответ чата портил бы чужой конфиг и
 *    подкладывал Continue модель Claude. С `--config` `cn` берёт файл как есть.
 *    Файла нет — флага нет: тогда `cn` идёт своим путём (вход в Continue Hub), и
 *    подсовывать ему несуществующий путь значило бы сломать вход.
 *
 * 3. `CONTINUE_GLOBAL_DIR` в окружении панели — `cn` читает каталог оттуда, а
 *    панель этой переменной не знает (переопределение не задокументировано,
 *    `config-dirs.ts`). Чей файл он прочтёт, панель тогда не знает — и `--config`
 *    не ставит, чтобы не подменить человеку конфиг.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OneShotRun } from '../types.ts';
import { continueHome } from './config-dirs.ts';

/** Инструменты `cn`, которыми модель меняет файлы (оболочка — тоже правка). */
export const CONTINUE_EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'Bash'] as const;

export interface ContinueArgsDeps {
  /** Проверка существования файла — подменяется в тестах. */
  exists?: (path: string) => boolean;
  /** Окружение панели (по умолчанию `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Каталог конфигурации Continue (по умолчанию `continueHome()`). */
  home?: string;
}

/** `--config <файл>`, если его стоит передать; иначе пусто (см. шапку, п. 2–3). */
export function continueConfigArgs(deps: ContinueArgsDeps = {}): string[] {
  const env = deps.env ?? process.env;
  if (env.CONTINUE_GLOBAL_DIR) return [];
  const file = join(deps.home ?? continueHome(), 'config.yaml');
  return (deps.exists ?? existsSync)(file) ? ['--config', file] : [];
}

/** Флаги прав под «Разрешить правки»; не задано — argv как до переключателя. */
export function continueEditArgs(allowEdits: boolean | undefined): string[] {
  if (allowEdits === undefined) return [];
  const flag = allowEdits ? '--allow' : '--exclude';
  return CONTINUE_EDIT_TOOLS.flatMap((tool) => [flag, tool]);
}

/** Полный argv `cn`: опции до `-p`, промпт — отдельным последним элементом. */
export function continueOneShotArgs(
  prompt: string,
  run?: OneShotRun,
  deps?: ContinueArgsDeps,
): string[] {
  return [...continueConfigArgs(deps), ...continueEditArgs(run?.allowEdits), '-p', prompt];
}
