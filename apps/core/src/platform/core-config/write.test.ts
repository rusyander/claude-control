import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdirSync } from 'node:fs';
import type { ConfigView } from '@agentdeck/contracts/core/config';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { layoutOf, type CoreHomeLayout } from '../core-home.ts';
import { ABSENT_FILE, configFilesOf, NO_CONFIG_DIGEST, sha256Hex } from './files.ts';
import { readCoreConfig, watchConfigDrift } from './read.ts';
import { readConfigState } from './state.ts';
import {
  adoptCoreConfig,
  currentConfigDigest,
  recoverPending,
  writeCoreConfig,
  type ConfigWriteOptions,
} from './write.ts';

/**
 * Писатель настройки и дрейф (00:58, G6, P47): запись только через ядро, с упреждающей памятью;
 * правка мимо API не действует (действует последняя запись ядра) и названа; крах посреди записи
 * читается восстановлением, не дрейфом; тот же `cmdId` — без второй записи; отпечаток базы —
 * последняя запись ядра. Windows: замена файла, который держит читатель, повторяется на EPERM.
 */

const META = { by: 'nonce+peer', warnings: [], at: 1_000 };
const NO_SLEEP = { attempts: 6, delayMs: () => 0, sleep: () => {} };

function home(): CoreHomeLayout {
  const layout = layoutOf(tempDir('core-config-w-'));
  mkdirSync(layout.root, { recursive: true });
  return layout;
}

function viewOf(layout: CoreHomeLayout): ConfigView {
  const read = readCoreConfig(layout);
  if (!('value' in read)) throw new Error(`not read: ${JSON.stringify(read)}`);
  return read.value;
}

function write(
  layout: CoreHomeLayout,
  doc: Parameters<typeof writeCoreConfig>[1],
  cmdId: string,
  opts: ConfigWriteOptions = {},
): ReturnType<typeof writeCoreConfig> {
  return writeCoreConfig(layout, doc, currentConfigDigest(layout), cmdId, META, opts);
}

describe('core config writer', () => {
  it('a core write lands in config.json, its last copy and the state; files are 0600 on POSIX', () => {
    const layout = home();
    const got = write(layout, { forgePoll: ['/a'] }, 'c1');
    expect(got.kind).toBe('applied');
    const files = configFilesOf(layout);
    const text = readFileSync(files.config, 'utf8');
    expect(JSON.parse(text)).toEqual({ v: 1, forgePoll: ['/a'] });
    expect(readFileSync(files.last, 'utf8')).toBe(text);
    const state = readConfigState(files.state);
    expect('value' in state && state.value).toMatchObject({
      digest: sha256Hex(text),
      cmds: [{ cmdId: 'c1' }],
    });
    expect('value' in state && state.value.pending).toBeUndefined();
    expect(viewOf(layout)).toMatchObject({ doc: { v: 1, forgePoll: ['/a'] }, drift: null });
    if (process.platform !== 'win32') {
      for (const f of [files.config, files.last, files.state]) {
        expect(statSync(f).mode & 0o777).toBe(0o600);
      }
    }
  });

  it('P47 the same cmdId answers with its stored outcome and writes nothing a second time', () => {
    const layout = home();
    const first = write(layout, { forgePoll: ['/a'] }, 'c1');
    const before = readFileSync(layout.config, 'utf8');
    const again = writeCoreConfig(layout, { forgePoll: ['/other'] }, NO_CONFIG_DIGEST, 'c1', META);
    expect(again).toEqual({ kind: 'replayed', cmd: first.kind === 'applied' ? first.cmd : null });
    expect(readFileSync(layout.config, 'utf8')).toBe(before);
  });

  it('a baseDigest that is not the last core write is refused stale with the current digest, nothing written', () => {
    const layout = home();
    write(layout, { forgePoll: ['/a'] }, 'c1');
    const current = currentConfigDigest(layout);
    const before = readFileSync(layout.config, 'utf8');
    const got = writeCoreConfig(layout, { forgePoll: ['/b'] }, NO_CONFIG_DIGEST, 'c2', META);
    expect(got).toEqual({ kind: 'stale', digest: current });
    expect(readFileSync(layout.config, 'utf8')).toBe(before);
  });

  it('crash after config.json, before the state: the reader sees recovery (no drift), boot recovery finalizes the cmd', () => {
    const layout = home();
    write(layout, { forgePoll: ['/a'] }, 'c1');
    const crash: ConfigWriteOptions = {
      step: (done) => {
        if (done === 'config') throw new Error('power cut');
      },
    };
    expect(() => write(layout, { forgePoll: ['/b'] }, 'c2', crash)).toThrow('power cut');
    expect(viewOf(layout)).toMatchObject({ doc: { forgePoll: ['/b'] }, drift: null });
    expect(recoverPending(layout)).toMatchObject({ recovered: { cmdId: 'c2' } });
    const files = configFilesOf(layout);
    expect(readFileSync(files.last, 'utf8')).toBe(readFileSync(files.config, 'utf8'));
    expect(write(layout, { forgePoll: ['/x'] }, 'c2').kind).toBe('replayed');
  });

  it('crash after the pending state, before config.json: the file is untouched, the pending write is dropped', () => {
    const layout = home();
    write(layout, { forgePoll: ['/a'] }, 'c1');
    const crash: ConfigWriteOptions = {
      step: (done) => {
        if (done === 'pending') throw new Error('power cut');
      },
    };
    expect(() => write(layout, { forgePoll: ['/b'] }, 'c2', crash)).toThrow('power cut');
    expect(viewOf(layout)).toMatchObject({ doc: { forgePoll: ['/a'] }, drift: null });
    expect(recoverPending(layout)).toMatchObject({ dropped: { cmdId: 'c2' } });
    expect(write(layout, { forgePoll: ['/b'] }, 'c2').kind).toBe('applied');
  });

  it('the very first write crashing before the file exists reads as no config, not unknown', () => {
    const layout = home();
    const crash: ConfigWriteOptions = {
      step: (done) => {
        if (done === 'pending') throw new Error('power cut');
      },
    };
    expect(() => write(layout, { forgePoll: ['/b'] }, 'c1', crash)).toThrow('power cut');
    expect(readCoreConfig(layout)).toEqual({ absent: true });
    recoverPending(layout);
    expect(readCoreConfig(layout)).toEqual({ absent: true });
  });

  it('Windows trap: a rename refused with EPERM (reader holds the file) is retried and lands', () => {
    const layout = home();
    write(layout, { forgePoll: ['/a'] }, 'c1');
    let refusals = 0;
    const rename = (from: string, to: string): void => {
      if (to === layout.config && refusals < 2) {
        refusals += 1;
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      renameSync(from, to);
    };
    expect(write(layout, { forgePoll: ['/b'] }, 'c2', { rename, retry: NO_SLEEP }).kind).toBe(
      'applied',
    );
    expect(refusals).toBe(2);
    expect(viewOf(layout).doc).toEqual({ v: 1, forgePoll: ['/b'] });
  });

  it('a real read handle released between rename attempts: the write lands (Windows refuses the first rename for real)', () => {
    const layout = home();
    write(layout, { forgePoll: ['/a'] }, 'c1');
    let fd: number | undefined = openSync(layout.config, 'r');
    let refused = 0;
    const rename = (from: string, to: string): void => {
      try {
        renameSync(from, to);
      } catch (error) {
        // Читатель отпускает файл после первого отказа — как читатель очереди через миг.
        refused += 1;
        if (fd !== undefined) closeSync(fd);
        fd = undefined;
        throw error;
      }
    };
    try {
      expect(write(layout, { forgePoll: ['/b'] }, 'c2', { rename, retry: NO_SLEEP }).kind).toBe(
        'applied',
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    expect(refused).toBe(process.platform === 'win32' ? 1 : 0);
    expect(viewOf(layout)).toMatchObject({ doc: { forgePoll: ['/b'] }, drift: null });
  });

  it('a read handle held through every retry: Windows refuses the write loudly, the previous config stays in force, no drift', () => {
    const layout = home();
    write(layout, { forgePoll: ['/a'] }, 'c1');
    const fd = openSync(layout.config, 'r');
    let outcome: string;
    try {
      outcome = write(layout, { forgePoll: ['/b'] }, 'c2', { retry: NO_SLEEP }).kind;
    } catch (error) {
      outcome = (error as { code?: string }).code ?? 'error';
    } finally {
      closeSync(fd);
    }
    if (process.platform === 'win32') {
      expect(outcome).toBe('EPERM');
      expect(viewOf(layout)).toMatchObject({ doc: { forgePoll: ['/a'] }, drift: null });
      expect(recoverPending(layout)).toMatchObject({ dropped: { cmdId: 'c2' } });
      // Человек повторяет тем же ключом — запись проходит.
      expect(write(layout, { forgePoll: ['/b'] }, 'c2').kind).toBe('applied');
    } else {
      expect(outcome).toBe('applied');
    }
    expect(viewOf(layout)).toMatchObject({ doc: { forgePoll: ['/b'] }, drift: null });
  });
});

describe('core config drift (G6)', () => {
  it('an edit outside the API does not take effect: the last core write does, drift names file digest, sections, time', () => {
    const layout = home();
    write(layout, { forgePoll: ['/a'], trustedRepos: ['/r'] }, 'c1');
    const own = currentConfigDigest(layout);
    const told: ConfigView[] = [];
    const stop = watchConfigDrift(layout, (v) => told.push(v));
    try {
      const planted = JSON.stringify({ v: 1, trustedRepos: ['/r'], forgePoll: ['/a', '/evil'] });
      writeFileSync(layout.config, planted);
      const read = viewOf(layout);
      expect(read.doc).toEqual({ v: 1, forgePoll: ['/a'], trustedRepos: ['/r'] });
      expect(read.digest).toBe(own);
      expect(read.drift).toEqual({
        fileDigest: sha256Hex(planted),
        sections: ['forgePoll'],
        at: statSync(layout.config).mtimeMs,
      });
      expect(told).toHaveLength(1);
    } finally {
      stop();
    }
    viewOf(layout);
    expect(told).toHaveLength(1);
  });

  it('key order alone is not a changed section; an unparsable file changes "*"; a deleted file is drift too', () => {
    const layout = home();
    write(layout, { forgePoll: ['/a'], trustedRepos: ['/r'] }, 'c1');
    writeFileSync(layout.config, JSON.stringify({ trustedRepos: ['/r'], forgePoll: ['/a'], v: 1 }));
    expect(viewOf(layout).drift?.sections).toEqual([]);
    writeFileSync(layout.config, '{broken');
    expect(viewOf(layout)).toMatchObject({
      doc: { forgePoll: ['/a'] },
      drift: { sections: ['*'] },
    });
    rmSync(layout.config);
    expect(viewOf(layout)).toMatchObject({
      doc: { forgePoll: ['/a'] },
      drift: { fileDigest: ABSENT_FILE, sections: ['*'] },
    });
  });

  it('a drifted file with a tampered last copy is unknown — neither the file nor the copy takes effect', () => {
    const layout = home();
    write(layout, { forgePoll: ['/a'] }, 'c1');
    writeFileSync(layout.config, '{"forgePoll":["/evil"]}');
    writeFileSync(configFilesOf(layout).last, '{"forgePoll":["/evil"]}');
    expect(readCoreConfig(layout)).toEqual({
      unknown: 'config.json drifted and config.last.json is not the last core write',
    });
  });

  it('a pre-stage-7 file (no state) is in force as is; adopted once, a later edit is drift; adoption is idempotent', () => {
    const layout = home();
    writeFileSync(layout.config, '{"forgePoll":["/a"]}');
    expect(viewOf(layout)).toMatchObject({ doc: { forgePoll: ['/a'] }, drift: null });
    expect(adoptCoreConfig(layout, 5)).toEqual({ digest: sha256Hex('{"forgePoll":["/a"]}') });
    expect(adoptCoreConfig(layout, 6)).toBeUndefined();
    writeFileSync(layout.config, '{"forgePoll":["/a","/b"]}');
    expect(viewOf(layout)).toMatchObject({
      doc: { forgePoll: ['/a'] },
      drift: { sections: ['forgePoll'] },
    });
  });

  it('adopting a drifted file is a core write of its document from the last core digest; the drift clears', () => {
    const layout = home();
    write(layout, { forgePoll: ['/a'] }, 'c1');
    writeFileSync(layout.config, '{"forgePoll":["/a","/b"]}');
    const read = viewOf(layout);
    expect(read.drift).not.toBeNull();
    const got = writeCoreConfig(layout, { forgePoll: ['/a', '/b'] }, read.digest, 'c2', META);
    expect(got.kind).toBe('applied');
    expect(viewOf(layout)).toMatchObject({ doc: { forgePoll: ['/a', '/b'] }, drift: null });
  });

  it('the first core write over a pre-stage-7 file adopts it first, so a crash leaves a usable last copy', () => {
    const layout = home();
    writeFileSync(layout.config, '{"forgePoll":["/a"]}');
    const crash: ConfigWriteOptions = {
      step: (done) => {
        if (done === 'pending') throw new Error('power cut');
      },
    };
    expect(() => write(layout, { forgePoll: ['/b'] }, 'c1', crash)).toThrow('power cut');
    recoverPending(layout);
    writeFileSync(layout.config, '{"forgePoll":["/evil"]}');
    expect(viewOf(layout)).toMatchObject({
      doc: { forgePoll: ['/a'] },
      drift: { sections: ['forgePoll'] },
    });
  });
});
