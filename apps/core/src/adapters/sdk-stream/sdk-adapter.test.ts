import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CliAdapter, LayerRun, SessionHandle } from '../adapter.types.ts';
import { CLAUDE_CAPS } from '../claude/claude.ts';
import { mapClaudePermission } from '../claude/permission.ts';
import { liveRoot, livePin, liveSpec } from '../conformance/__fixtures__/live.ts';
import { installReplay, readDump, replayEnv } from '../conformance/__fixtures__/replay.ts';
import { createSdkAdapter, type SdkAdapterDef, type SdkAdapterOptions } from './sdk-adapter.ts';

/**
 * Каркас переходника без необязательного: нет адреса, нет своего окружения сессии, нет
 * `initialize` и разбора ошибок. Подставной CLI лежит ТОЛЬКО в каталоге поиска переходника
 * (`extraDirs`), не в PATH, — так видно, что каталог доходит до разрешения команды.
 */

const COMMAND = 'sdk-probe-cli';
const live = liveRoot('adp-sdk-');
const bin = join(live.root, 'extra-bin');
mkdirSync(bin, { recursive: true });
installReplay(bin, COMMAND);

// Файл, который node обязан подгрузить: оставляет метку, что `--require` дошёл до процесса.
const requireFile = join(live.root, 'require-mark.cjs');
const mark = join(live.root, 'require-mark.txt');
writeFileSync(
  requireFile,
  `require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'loaded');\n`,
  'utf8',
);

/** Слой, с которым каркас позвал план (F-86: план строится по слою на деле). */
const planned: LayerRun[] = [];

const def: SdkAdapterDef = {
  id: 'sdk-probe',
  caps: CLAUDE_CAPS,
  command: COMMAND,
  echo: false,
  bindEndpoint: () => ({ ok: false, code: 'no_channel' }),
  layer: { readCliMark: async () => ({ trusted: false }), untrusted: () => 'observe' },
  readLayer: (pin) => ({ dirs: [join(pin.HOME ?? '', 'probe-layer')], credentials: [] }),
  plan: (_spec, _binding, layer) => {
    planned.push(layer);
    return {
      args: ['--probe', 'plan-arg'],
      env: { PLAN_VAR: 'plan-value' },
      files: { 'plan/notes.txt': 'plan file' },
    };
  },
  mapPermission: mapClaudePermission,
};

const open: { adapter: CliAdapter; handle: SessionHandle }[] = [];
afterAll(async () => {
  for (const { adapter, handle } of open) await adapter.stop(handle, 'tree');
});

function launchProbe(options: SdkAdapterOptions, dump: string) {
  const adapter = createSdkAdapter(def, { pollMs: 20, ...options });
  const spec = liveSpec(live, {
    env: {
      pin: livePin(live, replayEnv({ dump, exit: 0 })),
      nodeRequires: [requireFile],
    },
  });
  return { adapter, spec, launched: adapter.launch(spec) };
}

async function waitDump(file: string): Promise<NonNullable<ReturnType<typeof readDump>>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const dump = readDump(file);
    if (dump) return dump;
    if (Date.now() > deadline) throw new Error('probe CLI never started');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('sdk adapter frame without optional parts', () => {
  it('launches from the adapter search dir: argv is the plan, plan env and node requires reach the CLI, plan files land in the session dir', async () => {
    const dumpFile = join(live.root, 'dump-ok.json');
    const { adapter, spec, launched } = launchProbe({ extraDirs: [bin] }, dumpFile);
    const result = await launched;
    if (!result.ok) throw new Error(`launch refused: ${result.reason}`);
    open.push({ adapter, handle: result.handle });
    const dump = await waitDump(dumpFile);
    // Без адреса нет привязки: ни её argv, ни её окружения — только план.
    expect(dump.argv).toEqual(['--probe', 'plan-arg']);
    expect(dump.env.PLAN_VAR).toBe('plan-value');
    // Путь в NODE_OPTIONS экранирован для разбора node — доказательство в метке, а не в строке.
    expect(dump.env.NODE_OPTIONS ?? '').toContain('--require');
    expect(readFileSync(mark, 'utf8')).toBe('loaded');
    expect(readFileSync(join(spec.dir, 'plan', 'notes.txt'), 'utf8')).toBe('plan file');
    expect(adapter.session(result.handle)).toBeDefined();
  });

  it('a command outside PATH and without the search dir fails the launch with the reason, no session kept', async () => {
    const dumpFile = join(live.root, 'dump-missing.json');
    const { adapter, spec, launched } = launchProbe({}, dumpFile);
    const result = await launched;
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('launched without the search dir');
    expect(result.reason).toContain(COMMAND);
    expect(result.reason).toContain('not found');
    expect(existsSync(dumpFile)).toBe(false);
    expect(adapter.session({ sessionId: spec.sessionId } as SessionHandle)).toBeUndefined();
  });
});

describe('sdk adapter frame — F-86 the layer the session ran', () => {
  it('F-86: no source repo in the spec → the launch reports the downgrade and the plan is built for it', async () => {
    const dumpFile = join(live.root, 'dump-untrusted.json');
    const adapter = createSdkAdapter(def, { pollMs: 20, extraDirs: [bin] });
    const { trust: _trust, ...untrusted } = liveSpec(live, {
      env: { pin: livePin(live, replayEnv({ dump: dumpFile, exit: 0 })) },
    });
    planned.length = 0;
    const result = await adapter.launch(untrusted);
    if (!result.ok) throw new Error(`launch refused: ${result.reason}`);
    open.push({ adapter, handle: result.handle });
    expect(result.layer).toEqual({
      asked: 'on',
      ran: 'observe',
      repoLayer: false,
      trust: 'none',
      detail: 'the launch names no source repo',
    });
    expect(planned).toEqual([result.layer]);
  });
});
