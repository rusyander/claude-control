import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProvider } from '../../../providers/registry.ts';
import { runSupervisorEvent, type SupervisorHook } from './run.ts';

/**
 * Хук группы прогона (`owner: 'layer'`) у Codex: событие `UserPromptSubmit` у
 * Codex своё, и записи его файлов надзиратель не трогает (иначе — дважды). Слой
 * в файлы Codex не пишет, поэтому его хук обязан сыграть надзиратель. Скрипт —
 * настоящий, запущенный настоящей оболочкой.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-sup-layer-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function denyHook(owner: SupervisorHook['owner']): SupervisorHook {
  const path = join(dir, 'deny.cjs');
  writeFileSync(
    path,
    `process.stdin.on('data', () => {});
process.stdin.on('end', () => { process.stderr.write('LAYER_DENY'); process.exit(2); });`,
  );
  return { event: 'UserPromptSubmit', command: `node "${path}"`, ...(owner ? { owner } : {}) };
}

const play = (hook: SupervisorHook) =>
  runSupervisorEvent({
    provider: getProvider('codex'),
    run: {
      providerId: 'codex',
      sessionId: 'chat',
      cwd: dir,
      transcriptPath: join(dir, 'chat.jsonl'),
    },
    input: { event: 'UserPromptSubmit', prompt: 'x' },
    hooks: [hook],
  });

describe('надзиратель: хук слоя группы на родном событии цели', () => {
  it('owner layer — играет надзиратель, отказ действует', async () => {
    const outcome = await play(denyHook('layer'));
    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toContain('LAYER_DENY');
  });

  it('контроль: запись цели на том же событии надзиратель не играет', async () => {
    const outcome = await play(denyHook(undefined));
    expect(outcome.results).toHaveLength(0);
    expect(outcome.blocked).toBe(false);
  });
});
