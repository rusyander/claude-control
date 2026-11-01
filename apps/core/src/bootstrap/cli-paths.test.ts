import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createAdapterRegistry,
  type AdapterOptions,
  type CliAdapter,
  type SessionHandle,
} from '../adapters/index.ts';
import { liveRoot, livePin, liveSpec } from '../adapters/conformance/__fixtures__/live.ts';
import { installReplay, readDump, replayEnv } from '../adapters/conformance/__fixtures__/replay.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { layoutOf } from '../platform/core-home.ts';
import { npmCmdShim } from '../platform/__fixtures__/shims.ts';
import { cliPathOf } from './cli-paths.ts';
import { createCliVersionReader } from './economy-wiring/base-start.ts';

/**
 * F9: раздел `cliPaths` настройки ядра доходит до предпроверки дороги `cli`, до запуска сессии
 * через реестр переходников и до `--version` того же CLI — один и тот же путь. Читается на каждом
 * обращении: правка без перезапуска ядра.
 */

const CLAUDE_BIN =
  process.platform === 'win32' ? 'C:\\tools\\claude\\claude.cmd' : '/opt/claude/bin/claude';
const OTHER_BIN = process.platform === 'win32' ? 'D:\\claude-next\\claude.cmd' : '/opt/next/claude';

function homeWith(doc: unknown) {
  const layout = layoutOf(tempDir('core-cli-paths-'));
  mkdirSync(layout.root, { recursive: true });
  if (doc !== undefined) writeFileSync(layout.config, JSON.stringify(doc));
  return layout;
}

const open: { adapter: CliAdapter; handle: SessionHandle }[] = [];
afterAll(async () => {
  for (const { adapter, handle } of open) await adapter.stop(handle, 'tree');
});

describe('core config cliPaths (F9)', () => {
  it('the registry probes the configured path; an adapter without one keeps its CLI image name', () => {
    const layout = homeWith({ v: 1, cliPaths: { claude: CLAUDE_BIN } });
    const registry = createAdapterRegistry({}, { cliPathOf: cliPathOf(layout) });
    expect(registry.cliOf?.('claude')).toBe(CLAUDE_BIN);
    expect(registry.cliOf?.('qwen')).toBe(registry.get('qwen')?.images[0]);
    expect(registry.cliOf?.('no-such-cli')).toBeUndefined();
  });

  it('an edit of the section is seen on the next read, without a new registry', () => {
    const layout = homeWith({ v: 1, cliPaths: { claude: CLAUDE_BIN } });
    const registry = createAdapterRegistry({}, { cliPathOf: cliPathOf(layout) });
    expect(registry.cliOf?.('claude')).toBe(CLAUDE_BIN);
    writeFileSync(layout.config, JSON.stringify({ v: 1, cliPaths: { claude: OTHER_BIN } }));
    expect(registry.cliOf?.('claude')).toBe(OTHER_BIN);
  });

  it('no config, or a config that does not parse, falls back to the PATH search name', () => {
    expect(cliPathOf(homeWith(undefined))('claude')).toBeUndefined();
    const broken = homeWith({ v: 1, cliPaths: { claude: 'relative/claude' } });
    expect(cliPathOf(broken)('claude')).toBeUndefined();
    const registry = createAdapterRegistry({}, { cliPathOf: cliPathOf(broken) });
    expect(registry.cliOf?.('claude')).toBe(registry.get('claude')?.images[0]);
  });

  it('a session of a registry adapter starts the configured file, never the PATH name', async () => {
    const stand = decoyStand('core-cli-paths-run-');
    // Подставной CLI хуков не исполняет — сеанс без хука ядра, как в наборе соответствия.
    const own = { unhookedForTests: true, pollMs: 20 } as AdapterOptions;
    const registry = createAdapterRegistry({ claude: own }, { cliPathOf: cliPathOf(stand.layout) });
    const adapter = registry.get('claude') as CliAdapter;
    const dump = join(stand.live.root, 'dump.json');
    const result = await adapter.launch(
      liveSpec(stand.live, { env: { pin: stand.pin(replayEnv({ dump, exit: 0 })) } }),
    );
    if (!result.ok) throw new Error(`launch refused: ${result.reason}`);
    open.push({ adapter, handle: result.handle });
    const deadline = Date.now() + 15_000;
    while (!readDump(dump) && !existsSync(stand.decoyRan) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(stand.decoyRan)).toBe(false);
    expect(readDump(dump)).not.toBeNull();
  }, 30_000);

  it('the CLI version a session records and the base key carry is read from the configured file', async () => {
    const stand = decoyStand('core-cli-paths-ver-');
    const registry = createAdapterRegistry({}, { cliPathOf: cliPathOf(stand.layout) });
    const read = createCliVersionReader();
    const version = await read({
      adapter: registry.get('claude') as CliAdapter,
      spec: {
        dir: join(stand.live.sessions, 'version'),
        cwd: stand.live.cwd,
        env: { pin: stand.pin({ REPLAY_VERSION: '4.2.0' }) },
      },
    } as unknown as Parameters<typeof read>[0]);
    expect(existsSync(stand.decoyRan)).toBe(false);
    expect(version).toBe('4.2.0');
  }, 30_000);
});

/**
 * Стенд запуска: настроенный подставной CLI вне PATH и ЛОЖНЫЙ `claude` первым в PATH пина — за
 * ним только каталог node (обёртке npm нужен `node`). Если путь из настройки потерян, запустится
 * ложный (метка + чужая версия), а не живой `claude`, лежащий рядом с node: проверка герметична
 * и краснеет, а не уходит к настоящему CLI.
 */
function decoyStand(prefix: string) {
  const live = liveRoot(prefix);
  const bin = join(live.root, 'configured-bin');
  mkdirSync(bin, { recursive: true });
  const name = 'claude-configured-f9';
  installReplay(bin, name);
  const file = join(bin, process.platform === 'win32' ? `${name}.cmd` : name);
  const decoyBin = join(live.root, 'path-bin');
  const decoyRan = join(live.root, 'decoy-ran');
  installDecoy(decoyBin, decoyRan);
  const narrow = [decoyBin, dirname(process.execPath)].join(delimiter);
  return {
    live,
    decoyRan,
    layout: homeWith({ v: 1, cliPaths: { claude: file } }),
    pin: (extra: Record<string, string>) => ({
      ...livePin(live, extra),
      PATH: narrow,
      ...(process.platform === 'win32' ? { Path: narrow } : {}),
    }),
  };
}

function installDecoy(bin: string, marker: string): void {
  const script = [
    "const { writeFileSync } = process.getBuiltinModule('node:fs');",
    `writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));`,
    "process.stdout.write('6.6.6 (decoy)\\n');",
    '',
  ].join('\n');
  if (process.platform === 'win32') {
    const pkg = join(bin, 'node_modules', 'decoy-cli');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'cli.mjs'), script);
    writeFileSync(join(bin, 'claude.cmd'), npmCmdShim('node_modules\\decoy-cli\\cli.mjs'));
    return;
  }
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node\n${script}`);
  chmodSync(join(bin, 'claude'), 0o755);
}
