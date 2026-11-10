import { join } from 'node:path';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { afterEach, describe, expect, it } from 'vitest';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { loginRoute } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Модели маршрута доходят до суда `tier` на НАСТОЯЩЕЙ загрузке (этап 12, W1-D): окружение суда
 * шага (`routingEnv` экономики загрузки) несёт `servedModels` из книги `route-windows.ts`, а она
 * читает `route.read.models` реестра этой загрузки. Без этого вариант клика `model:<id>` у ждущей
 * задачи строился по одному шаблону набора, и клик упирался в отказ `compat` `model_absent`.
 * Подменённого нет: реестр маршрутов, маршрут-заглушка, книга и экономика — те, что у продукта.
 * Вход CLI своих моделей ядру не называет — у него список неизвестен, и вариант остаётся.
 */

const booted: BootedCore[] = [];
afterEach(async () => {
  for (const core of booted.splice(0)) await core.stop();
});

const CLAUDE = claudeRunFacts.id;
const STUB = 'stub:served';

async function settledList(
  read: (id: string) => readonly string[] | null,
  id: string,
): Promise<readonly string[] | null> {
  // Проход суда уже начал чтение: ждём его итог, перечитывая книгу (она отвечает прочитанным).
  for (let i = 0; i < 50 && read(id) === null; i += 1) await new Promise((r) => setTimeout(r, 10));
  return read(id);
}

describe('boot: the model list of a route reaches the tier judge', () => {
  it('routingEnv warms the read of every allowed route: the stub route answers its served ids, the CLI login judges nothing', async () => {
    const core = await bootCore({
      home: join(tempDir('served-models-core-'), 'core'),
      build: 'served-models-test',
      loop: false,
      routeConfig: { stub: [{ name: 'served', models: ['stub-model'], script: ['ok'] }] },
    });
    booted.push(core);
    const login = loginRoute(CLAUDE);
    const task = await core.registry.create({
      ...CREATED,
      allowedRoutes: [
        { adapter: CLAUDE, route: { kind: 'cli-login', id: login }, modelPattern: '*' },
        { adapter: CLAUDE, route: { kind: 'stub', id: STUB }, modelPattern: 'stub-alt' },
      ],
    });
    const served = core.economy.routingEnv!(task).tier?.servedModels;
    expect(served, 'routingEnv carries servedModels').toBeTypeOf('function');
    expect(await settledList(served!, STUB)).toEqual(['stub-model']);
    expect(await settledList(served!, login)).toBeNull();
    expect(served!('no-such-route')).toBeNull();
  });
});
