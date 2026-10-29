import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CAPTURE_SHIM, captureTokenPath } from '../platform/capture-shim.ts';
import { quoteNodeOption } from '../platform/spawn.ts';
import { runCaptureCommand } from './capture-command.ts';

/**
 * `capture install|remove|status` (04:41, G5) — только над файлом настроек и домом ядра
 * песочницы: настоящий `~/.claude` и профиль оболочки не трогаются никогда (команда без
 * `--settings` отказывает, а не угадывает файл CLI).
 */

const root = mkdtempSync(join(tmpdir(), 'capture-cmd-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const read = (file: string) =>
  JSON.parse(readFileSync(file, 'utf8')) as { env?: Record<string, string>; [k: string]: unknown };

describe('capture command over a throwaway settings file and core home', () => {
  const home = join(root, 'core home');
  const settings = join(root, 'settings.json');
  writeFileSync(
    settings,
    JSON.stringify({
      model: 'x',
      env: { NODE_OPTIONS: '--max-old-space-size=4096', KEEP: '1' },
    }),
  );

  it('without --settings it refuses and writes nothing', async () => {
    const t = io();
    expect(await runCaptureCommand(['install'], t.io)).toBe(2);
    expect(t.err[0]).toMatch(/^capture: --settings is required/);
    expect(await runCaptureCommand(['bogus'], t.io)).toBe(2);
  });

  it('status before install → exit 1, not installed', async () => {
    const t = io();
    expect(await runCaptureCommand(['status', '--settings', settings, '--home', home], t.io)).toBe(
      1,
    );
    expect(t.out[0]).toMatch(/^capture: not installed/);
  });

  it('install: shim first in NODE_OPTIONS, foreign entries and keys kept, capture access created', async () => {
    const t = io();
    expect(await runCaptureCommand(['install', '--settings', settings, '--home', home], t.io)).toBe(
      0,
    );
    const doc = read(settings);
    expect(doc['model']).toBe('x');
    expect(doc.env).toEqual({
      NODE_OPTIONS: `--require ${quoteNodeOption(CAPTURE_SHIM)} --max-old-space-size=4096`,
      KEEP: '1',
      AGENTDECK_CAPTURE_HOME: home,
    });
    expect(existsSync(captureTokenPath(home))).toBe(true);
    // Повторная установка не задваивает прокладку.
    expect(await runCaptureCommand(['install', '--settings', settings, '--home', home], t.io)).toBe(
      0,
    );
    expect(read(settings).env).toEqual(doc.env);
    const s = io();
    expect(await runCaptureCommand(['status', '--settings', settings], s.io)).toBe(0);
    expect(s.out).toContain('  node-preload: captured');
    expect(s.out.join('\n')).toMatch(/path-wrapper .*not captured outside core sessions/);
  });

  it('remove: both variables gone, foreign entries kept, access revoked; status → 1', async () => {
    const t = io();
    expect(await runCaptureCommand(['remove', '--settings', settings, '--home', home], t.io)).toBe(
      0,
    );
    expect(read(settings).env).toEqual({ NODE_OPTIONS: '--max-old-space-size=4096', KEEP: '1' });
    expect(existsSync(captureTokenPath(home))).toBe(false);
    const s = io();
    expect(await runCaptureCommand(['status', '--settings', settings, '--home', home], s.io)).toBe(
      1,
    );
  });

  it('a settings file that is not a JSON object is left untouched', async () => {
    const broken = join(root, 'broken.json');
    writeFileSync(broken, '[1,2]');
    const t = io();
    expect(await runCaptureCommand(['install', '--settings', broken, '--home', home], t.io)).toBe(
      2,
    );
    expect(readFileSync(broken, 'utf8')).toBe('[1,2]');
  });
});
