import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { sweepStaleLive } from './vitest.temp-sandbox.ts';

/** pid процесса, который уже завершился (живым он быть не может). */
function deadPid(): number {
  const run = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  return Number(run.stdout);
}

describe('live stand base sweep (vitest.temp-sandbox)', () => {
  it('removes only vl-* whose owner is dead or that are old and ownerless; live and foreign dirs stay', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const make = (name: string, owner?: number): string => {
        const dir = join(parent, name);
        mkdirSync(join(dir, 'work'), { recursive: true });
        writeFileSync(join(dir, 'work', 'file.txt'), 'x');
        if (owner !== undefined) writeFileSync(join(dir, 'owner.pid'), String(owner));
        return dir;
      };
      make('vl-dead', deadPid());
      make('vl-alive', process.pid);
      const legacyOld = make('vl-legacy-old');
      make('vl-legacy-new');
      // Чужой каталог старый и без владельца: снести его могло бы только отсутствие фильтра `vl-`.
      const foreign = make('q4-foreign');
      const now = Date.now();
      const old = new Date(now - 7 * 60 * 60 * 1000);
      utimesSync(legacyOld, old, old);
      utimesSync(foreign, old, old);

      const removed = (await sweepStaleLive(parent, now)).sort();

      expect(removed).toEqual(['vl-dead', 'vl-legacy-old']);
      expect(existsSync(join(parent, 'vl-alive'))).toBe(true);
      expect(existsSync(join(parent, 'vl-legacy-new'))).toBe(true);
      expect(existsSync(join(parent, 'q4-foreign'))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // Windows: процесс с рабочей папкой внутри не даёт удалить каталог — так держит его живой хост.
  it.runIf(process.platform === 'win32')(
    'a marked dir whose removal fails keeps owner.pid + mark, so the next run reaps it again',
    async () => {
      const parent = mkdtempSync(join(tmpdir(), 'sweep-busy-'));
      const dir = join(parent, 'vl-busy');
      const inside = join(dir, 'work');
      mkdirSync(inside, { recursive: true });
      writeFileSync(join(dir, 'owner.pid'), String(deadPid()));
      writeFileSync(join(dir, 'reap-owned'), '');
      const holder = spawn(
        process.execPath,
        ['-e', "process.stdout.write('up\\n'); setInterval(() => {}, 1e6)"],
        { cwd: inside, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      try {
        // Готовность — первая строка самого процесса, а не `spawn`: дескриптор рабочей папки
        // ребёнок открывает сам при старте, уже после возврата CreateProcess. Под нагрузкой
        // полного прогона снос успевал раньше — каталог ещё никто не держал (g13 p10).
        await new Promise((done) => holder.stdout.once('data', done));
        const reaped: string[] = [];

        const removed = await sweepStaleLive(parent, Date.now(), {
          reap: async (at) => void reaped.push(at),
        });

        expect(reaped).toEqual([dir]);
        expect(removed).toEqual([]);
        expect(existsSync(join(dir, 'reap-owned'))).toBe(true);
        expect(Number(readFileSync(join(dir, 'owner.pid'), 'utf8'))).toBe(process.pid);
      } finally {
        holder.kill();
        await new Promise((done) => holder.once('exit', done));
        rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  );
});
