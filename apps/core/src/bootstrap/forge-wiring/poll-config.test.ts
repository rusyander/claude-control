import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NO_CONFIG_DIGEST } from '../../platform/core-config/files.ts';
import { writeCoreConfig } from '../../platform/core-config/write.ts';
import { forgePollOf } from './poll-config.ts';

/**
 * `forgePoll` конфига ядра через единого читателя: список путей — включён для них; нет
 * файла/ключа — выключен молча; не JSON, не объект, не список строк, каталог вместо файла —
 * выключен с названной причиной; чужой негодный раздел не выключает; правка мимо API не действует.
 */

const root = mkdtempSync(join(tmpdir(), 'forge-poll-config-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function configWith(text: string): string {
  n += 1;
  const dir = join(root, `c${n}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.json');
  writeFileSync(file, text);
  return file;
}

describe('forgePollOf', () => {
  it('a list of paths enables exactly those repositories', () => {
    expect(forgePollOf(configWith('{"forgePoll":["C:/w/app","/srv/lib"]}'))).toEqual({
      repos: ['C:/w/app', '/srv/lib'],
    });
  });

  it('no key is off without a problem; a bad foreign section does not switch it off', () => {
    expect(forgePollOf(configWith('{"readAllow":{}}'))).toEqual({ repos: [] });
    expect(forgePollOf(configWith('{"forgePoll":["C:/w/app"],"queue":3}'))).toEqual({
      repos: ['C:/w/app'],
    });
  });

  it.each([
    ['not JSON', '{', /not JSON/],
    ['not an object', '[1]', /not an object/],
    ['a string, not a list', '{"forgePoll":"C:/w/app"}', /^forgePoll: .*expected array/],
    ['an object, not a list', '{"forgePoll":{"C:/w/app":true}}', /^forgePoll: .*expected array/],
    ['a non-string entry', '{"forgePoll":["C:/w/app",1]}', /^forgePoll: 1: /],
    ['an empty entry', '{"forgePoll":[""]}', /^forgePoll: 0: /],
  ])('%s is off and names the problem', (_name, text, problem) => {
    const got = forgePollOf(configWith(text));
    expect(got.repos).toEqual([]);
    expect(got.problem).toMatch(problem);
  });

  it('a missing file is off without a problem', () => {
    expect(forgePollOf(join(root, 'absent', 'config.json'))).toEqual({ repos: [] });
  });

  it('reads the file on every call (an edit applies on the next tick)', () => {
    const file = configWith('{"forgePoll":["C:/w/app"]}');
    expect(forgePollOf(file).repos).toEqual(['C:/w/app']);
    writeFileSync(file, '{}');
    expect(forgePollOf(file).repos).toEqual([]);
  });

  it('G6 after a core write, an edit outside the API does not switch polling on', () => {
    const file = join(root, 'g6', 'config.json');
    mkdirSync(join(root, 'g6'), { recursive: true });
    const meta = { by: 'nonce+peer', warnings: [], at: 1 };
    writeCoreConfig({ config: file }, { forgePoll: ['/srv/lib'] }, NO_CONFIG_DIGEST, 'c1', meta);
    expect(forgePollOf(file).repos).toEqual(['/srv/lib']);
    writeFileSync(file, '{"forgePoll":["/srv/lib","/srv/other"]}');
    expect(forgePollOf(file)).toEqual({ repos: ['/srv/lib'] });
  });

  it('an unreadable config (a directory) is off and names the problem', () => {
    const dir = join(root, 'dir', 'config.json');
    mkdirSync(dir, { recursive: true });
    const got = forgePollOf(dir);
    expect(got.repos).toEqual([]);
    expect(got.problem).toMatch(/unreadable/);
  });
});
