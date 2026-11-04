import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerContext } from '../../../context.ts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { decideDeferred, deferredAsksOf } from './deferred-store.ts';

/**
 * Продолжение чата после решения D-n вела сборка панели (`bootstrap/deferred-wiring`):
 * решение заводило ход прогона панели с готовой фразой. Ход чата теперь ведёт ядро
 * (этап 10, G14) — сборка снята, продолжателя нет. Записи, оставленные прежним
 * процессом, обязаны по-прежнему читаться с диска, показываться и решаться: решение
 * только записывается, хода само не заводит. Путь настоящий: файл записей на диске,
 * два контекста сервера — прежний процесс и новый.
 */

let root: string;
let appData: string;

const ctxOf = (): ServerContext =>
  ({
    store: new AppStore(appData),
    location: { paths: { root, appData } },
  }) as unknown as ServerContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-deferred-after-core-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('записи D-n после снятия продолжателя панели', () => {
  it('запись прежнего процесса читается, решается, и хода решение не заводит', async () => {
    const before = ctxOf();
    const asked = deferredAsksOf(before).ask({
      scope: { kind: 'chat', chatKeys: ['c1'] },
      runKeys: ['c1'],
      toolName: 'Bash',
      input: { command: 'npm publish' },
      reason: 'publish',
    });
    const id = asked.record.id;

    const after = ctxOf();
    expect(deferredAsksOf(after).get(id)?.state).toBe('waiting');

    const decided = await decideDeferred(after, id, { behavior: 'allow', via: 'web' });
    expect(decided).toMatchObject({ changed: true, item: { state: 'allowed' } });
    expect(decided).not.toHaveProperty('resume');
    expect(deferredAsksOf(after).get(id)?.toldAt).toBeUndefined();
  });
});
