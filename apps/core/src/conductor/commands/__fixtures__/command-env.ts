import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SplitEnv } from '../../estimate/index.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import { layoutOf, type CoreHomeLayout } from '../../../platform/core-home.ts';
import type { CommandEnv } from '../commands.types.ts';

/**
 * Среда команды для тестов: дом ядра и среда деления — как их дал бы API. Без `home`/`layout` —
 * дом в несуществующем временном каталоге (библиотека пуста, ничего не создаётся); без `split`
 * — дирижёр «не запущен», и запуск, утверждение и правка деления отказывают `preflight-unwired`.
 */
export function commandEnv(
  opts: { home?: string; layout?: CoreHomeLayout; split?: SplitEnv } = {},
): CommandEnv {
  const layout =
    opts.layout ?? layoutOf(opts.home ?? join(tmpdir(), `cmd-env-${newId().slice(-12)}`));
  const { split } = opts;
  return { layout, split: () => split };
}
