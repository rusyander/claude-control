import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Самопроверки скиллов наблюдения, запущенные из КОПИИ набора вне репозитория панели — так, как их получит
 * машина без личной копии в ~/.claude: рядом со скиллами лежит `hooks/lib/kit-paths.mjs` (по нему скрипты
 * узнают, что они в наборе), репозитория с group-watch/en.ts нет (тексты правил — из снимка), состояние
 * набора — во временном каталоге. Каждая самопроверка поднимает свою заглушку панели на 127.0.0.1:0 и
 * генерирует поддельный токен сама; код выхода 1 — хоть одна проверка красная.
 */

const KIT = process.env.AGENTDECK_KIT_UNDER_TEST || builtinKitDir();
const dir = mkdtempSync(join(tmpdir(), 'kit-watch-selftests-'));
const root = join(dir, 'kit');
for (const skill of ['watchdog', 'agentdeck-watchdog'])
  cpSync(join(KIT, 'skills', skill), join(root, 'skills', skill), { recursive: true });
mkdirSync(join(root, 'hooks', 'lib'), { recursive: true });
cpSync(join(KIT, 'hooks', 'lib', 'kit-paths.mjs'), join(root, 'hooks', 'lib', 'kit-paths.mjs'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function selftest(rel: string): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTDECK_KIT_STATE: join(dir, `state-${rel.replace(/\W+/g, '-')}`),
    };
    // Адрес живой панели из окружения увёл бы самопроверку с её заглушки.
    delete env.AGENTDECK_URL;
    delete env.PORT;
    delete env.CLAUDE_CODE_SESSION_ID;
    const child = spawn(process.execPath, [join(root, 'skills', rel)], { cwd: dir, env });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.on('close', (code) => done({ code, out }));
  });
}
const failures = (out: string) => out.split('\n').filter((l) => l.startsWith('FAIL'));
const passed = (out: string) => Number(/(\d+) passed, (\d+) failed/.exec(out)?.[1] ?? 0);

describe('самопроверки скиллов наблюдения из копии набора без репозитория', () => {
  // Нижняя граница — число проверок сейчас: самопроверка, у которой молча пропала часть, тоже красная.
  it.each([
    ['agentdeck-watchdog/scripts/selftest-groups.mjs', 147],
    ['agentdeck-watchdog/scripts/selftest-stage-audit.mjs', 86],
    ['watchdog/scripts/selftest.mjs', 141],
    ['watchdog/scripts/selftest-foreign.mjs', 86],
  ])(
    '%s — код 0, ни одной красной, не меньше %i проверок',
    async (rel, floor) => {
      const { code, out } = await selftest(rel);
      expect(failures(out), out.slice(-2000)).toEqual([]);
      expect(code, out.slice(-2000)).toBe(0);
      expect(passed(out)).toBeGreaterThanOrEqual(floor);
    },
    300_000,
  );
});
