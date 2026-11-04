import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { releaseTmp, releaseTmpSettled } from './resource-release.ts';

/**
 * Каталог, бывший cwd сессии (задача «ask»): на Windows его держит процесс, чей cwd он есть, —
 * `rmdir` даёт EBUSY, пока процесс не ушёл. Держатель здесь — настоящий дочерний процесс node
 * с этим cwd, без подмен ОС: снятие обязано дождаться его ухода в пределах срока, а не назвать
 * утечку сразу; и не ждать вечно, если держатель не уходит.
 */
const windows = process.platform === 'win32';
const holders: ChildProcess[] = [];
afterEach(() => {
  for (const h of holders.splice(0)) h.kill();
});

async function holdAsCwd(dir: string, ms: number): Promise<ChildProcess> {
  // Держатель говорит «готов» сам, уже стоя в каталоге: событие `spawn` приходит раньше.
  const child = spawn(
    process.execPath,
    ['-e', `process.stdout.write(process.cwd() + '\\n'); setTimeout(() => {}, ${ms})`],
    { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  holders.push(child);
  await new Promise<void>((done) => child.stdout?.once('data', () => done()));
  return child;
}

function scratch(): string {
  const dir = join(tempDir('rel-tmp-'), 'agentdeck-ask-x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'note.txt'), 'x');
  return dir;
}

describe('снятие временного каталога, бывшего cwd сессии', () => {
  it.skipIf(!windows)(
    'держатель уходит через ~1,5 с: однократное снятие — EBUSY-утечка, снятие со сроком — снято и прочитано назад',
    async () => {
      const dir = scratch();
      const holder = await holdAsCwd(dir, 60_000);
      const once = releaseTmp(dir);
      expect('leak' in once && once.leak).toMatch(/EBUSY|EPERM/);
      setTimeout(() => holder.kill(), 1_500);
      const settled = await releaseTmpSettled(dir, 10_000, 100);
      expect(settled).toEqual({ verified: `${dir} absent` });
      expect(existsSync(dir)).toBe(false);
    },
    20_000,
  );

  it.skipIf(!windows)(
    'держатель не уходит: срок кончается утечкой с причиной ОС, а не «снято» и не вечным ожиданием',
    async () => {
      const dir = scratch();
      await holdAsCwd(dir, 60_000);
      const started = Date.now();
      const settled = await releaseTmpSettled(dir, 600, 100);
      expect('leak' in settled && settled.leak).toMatch(/EBUSY|EPERM/);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(existsSync(dir)).toBe(true);
    },
    20_000,
  );

  it('свободный каталог снимается сразу; отсутствующий — уже снят', async () => {
    const dir = scratch();
    expect(await releaseTmpSettled(dir, 0)).toEqual({ verified: `${dir} absent` });
    expect(await releaseTmpSettled(dir, 0)).toEqual({ verified: `${dir} absent` });
  });
});
