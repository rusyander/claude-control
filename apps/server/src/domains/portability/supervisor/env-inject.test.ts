import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Group } from '@agentdeck/contracts';
import type { EnvItem, EnvSource, SecretItem, EnvVarItem } from '@agentdeck/contracts/portable-env';
import { setStoredKey } from '../../../lib/provider-keys.ts';
import { spawnCliProcess } from '../../../lib/cli-spawn.ts';
import { qwenProvider } from '../../../providers/catalog/qwen.ts';
import {
  buildPortableEnv,
  describePortableEnv,
  planSecretFileWrite,
  type PortableEnvRequest,
} from './env-inject.ts';

/**
 * Окружение чужого прогона: что панель подмешивает и чего не подмешивает никогда.
 *
 * Таблица здесь охраняет РЕШЕНИЯ (кто сильнее, что названо, что не подставлено),
 * а не дорогу до процесса: дорогу проверяет `tools/qa/check-portability-secrets.mjs`
 * поддельным CLI, который сбрасывает своё окружение в файл. Последний случай в
 * этом файле — врезка в `cli-spawn`: она проверяется настоящим процессом, потому
 * что шпион на `spawnImpl` не увидел бы потерю опции по дороге в spawn.
 */

/** Значение-маркер: синтетическое и собранное из кусков, чтобы в коде не лежало похожего на ключ. */
const MARKER = ['unit', 'marker', 'secret', '4d21'].join('-');

const source: EnvSource = {
  provider: 'qwen',
  scope: 'global',
  origin: 'file',
  file: 'C:/home/.qwen/.env',
  plugin: null,
};

function envVar(name: string, value: string): EnvVarItem {
  return {
    id: `envVar:${name}`,
    kind: 'envVar',
    source,
    intent: `переменная окружения ${name}`,
    trigger: { on: 'always' },
    blocking: 'inapplicable',
    needs: { resolution: 'none', why: 'переменная действует постоянно' },
    sideEffects: [],
    name,
    value,
    raw: `${name}=${value}`,
  };
}

function secret(name: string): SecretItem {
  return {
    id: `secret:${name}`,
    kind: 'secret',
    source,
    intent: `ключ ${name}`,
    trigger: { on: 'always' },
    blocking: 'inapplicable',
    needs: { resolution: 'none', why: 'ключ нужен процессу целиком' },
    sideEffects: ['reads_secrets'],
    name,
    mask: 'un…4d21',
    holder: 'panel',
  };
}

function group(id: string, isEnabled: boolean, env: Record<string, string>, order = 0): Group {
  return {
    id,
    name: id,
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env,
    isEnabled,
    order,
  };
}

let appData: string;
let emptyAppData: string;

beforeAll(() => {
  appData = mkdtempSync(join(tmpdir(), 'env-inject-store-'));
  emptyAppData = mkdtempSync(join(tmpdir(), 'env-inject-empty-'));
  setStoredKey(appData, 'qwen', MARKER);
  // Ключ из окружения самой машины ребёнок унаследовал бы и без панели, и случай
  // «панель ничего не подставила» стал бы неотличим от «подставила».
  delete process.env.OPENAI_API_KEY;
});

afterAll(() => {
  for (const dir of [appData, emptyAppData]) rmSync(dir, { recursive: true, force: true });
});

function request(items: readonly EnvItem[], extra: Partial<PortableEnvRequest> = {}) {
  return {
    provider: qwenProvider,
    appDataDir: appData,
    items,
    ...extra,
  } satisfies PortableEnvRequest;
}

describe('supervisor/env-inject: окружение целевого CLI', () => {
  it('значение ключа берётся из шифрованного хранилища, а не из канона', () => {
    const injection = buildPortableEnv(request([secret('OPENAI_API_KEY')]));
    expect(injection.env.OPENAI_API_KEY).toBe(MARKER);
    expect(injection.missing).toEqual([]);
  });

  it('секрета нет в хранилище — он НАЗВАН, а пустая строка не подставлена', () => {
    const injection = buildPortableEnv(
      request([secret('OPENAI_API_KEY')], { appDataDir: emptyAppData }),
    );
    expect(injection.missing).toEqual([{ name: 'OPENAI_API_KEY', gap: 'not_in_store' }]);
    // Именно «нет ключа вовсе», а не ключ с пустым значением: процесс обязан
    // отличать отсутствие ключа от заданного пустым.
    expect('OPENAI_API_KEY' in injection.env).toBe(false);
  });

  it('секрет, значения которого панель не держит, назван и не выдуман', () => {
    const injection = buildPortableEnv(request([secret('GITHUB_PAT')]));
    expect(injection.missing).toEqual([{ name: 'GITHUB_PAT', gap: 'not_held_by_panel' }]);
    expect(Object.keys(injection.env)).toEqual([]);
  });

  it('значение секрета в отчёт не попадает — там маска', () => {
    const lines = describePortableEnv(buildPortableEnv(request([secret('OPENAI_API_KEY')])));
    expect(lines.join('\n')).not.toContain(MARKER);
    expect(lines.join('\n')).toContain('…4d21');
  });

  it('выключенная группа своих переменных не подмешивает', () => {
    const injection = buildPortableEnv(
      request([], {
        groups: [
          group('on', true, { CC_GROUP_ON: 'on' }),
          group('off', false, { CC_GROUP_OFF: 'off' }),
        ],
      }),
    );
    expect(injection.env).toEqual({ CC_GROUP_ON: 'on' });
  });

  it('канон сильнее группы, а из двух групп хозяин первая по порядку', () => {
    const injection = buildPortableEnv(
      request([envVar('CC_SHARED', 'canon')], {
        groups: [
          group('second', true, { CC_SHARED: 'group', CC_OWNED: 'second' }, 2),
          group('first', true, { CC_OWNED: 'first' }, 1),
        ],
      }),
    );
    expect(injection.env.CC_SHARED).toBe('canon');
    expect(injection.env.CC_OWNED).toBe('first');
    expect(injection.lines.find((line) => line.name === 'CC_OWNED')?.groupId).toBe('first');
  });

  it('раздел, выключенный рубильником источника, не подмешивается', () => {
    const injection = buildPortableEnv(
      request([envVar('CC_PLAIN', 'x'), secret('OPENAI_API_KEY')], {
        sectionStates: [
          { kind: 'envVar', enabled: false, detail: 'disableAllEnv' },
          { kind: 'secret', enabled: true, detail: '' },
        ],
      }),
    );
    expect('CC_PLAIN' in injection.env).toBe(false);
    expect(injection.env.OPENAI_API_KEY).toBe(MARKER);
  });

  it('пустое значение обычной переменной — данные, оно доезжает', () => {
    const injection = buildPortableEnv(request([envVar('CC_EMPTY', '')]));
    expect(injection.env.CC_EMPTY).toBe('');
  });

  it('запись ключа в файл цели без галочки не планируется вовсе', () => {
    const plan = planSecretFileWrite(request([secret('OPENAI_API_KEY')]), false);
    expect(plan).toEqual({ write: false, vars: [] });
  });

  it('с галочкой план несёт ключ и предупреждение', () => {
    const plan = planSecretFileWrite(request([secret('OPENAI_API_KEY')]), true);
    expect(plan.write).toBe(true);
    expect(plan.warning).toBe('secret_in_plain_file');
    expect(plan.vars).toEqual([{ key: 'OPENAI_API_KEY', value: MARKER }]);
  });
});

/** Что процесс видит в своём окружении: спрашиваем его самого. */
function childEnv(portableEnv: () => Record<string, string>): Promise<Record<string, string>> {
  const code =
    'process.stdout.write(JSON.stringify({' +
    'key: process.env.OPENAI_API_KEY ?? "—", ' +
    'plain: process.env.CC_PLAIN ?? "—", ' +
    'path: process.env.PATH ?? process.env.Path ?? ""}))';

  return new Promise((resolve, reject) => {
    const spawned = spawnCliProcess(process.execPath, ['-e', code], { portableEnv });
    if (spawned.error) {
      reject(spawned.error);
      return;
    }
    let out = '';
    spawned.child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    spawned.child.on('error', reject);
    spawned.child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim()) as Record<string, string>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

describe('supervisor/env-inject: врезка в запуск', () => {
  it('добавка доезжает до настоящего процесса и остаётся добавкой', async () => {
    const injection = buildPortableEnv(
      request([envVar('CC_PLAIN', 'plain'), secret('OPENAI_API_KEY')]),
    );
    const child = await childEnv(() => injection.env);
    expect(child.key).toBe(MARKER);
    expect(child.plain).toBe('plain');
    expect((child.path ?? '').length).toBeGreaterThan(0);
  });

  it('недостающий секрет не превращается в пустую строку в окружении процесса', async () => {
    const injection = buildPortableEnv(
      request([secret('OPENAI_API_KEY')], { appDataDir: emptyAppData }),
    );
    const child = await childEnv(() => injection.env);
    // «—» ставит сам ребёнок вместо отсутствующей переменной: пустая строка здесь
    // означала бы, что панель подставила ключ, которого у неё нет.
    expect(child.key).toBe('—');
  });
});
