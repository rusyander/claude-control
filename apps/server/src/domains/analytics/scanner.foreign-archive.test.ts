import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanAnalytics } from './scanner.ts';
import type { ScanOptions } from './scanner.ts';

/**
 * Архив Qwen Code в аналитике (ревью W, 🟡 7). Панель больше не стирает
 * брошенную сессию, а убирает её в архив Qwen (`POST /sessions/archive`): файл
 * ПЕРЕЕЗЖАЕТ в `chats/archive/`, его расход — настоящий и считается (раньше
 * стёртая сессия уносила его). Одна сессия в двух местах сразу (копия вернула
 * её в работу) не должна считаться дважды: повторы ответов снимаются только
 * внутри одного файла. Строки — формы qwen 0.25 (`ui_telemetry`).
 */

const recent = (): string => new Date(Date.now() - 60 * 60_000).toISOString();

function telemetry(ts: string, id: string, input: number): unknown {
  return {
    uuid: `system-${id}`,
    sessionId: 's',
    timestamp: ts,
    type: 'system',
    subtype: 'ui_telemetry',
    systemPayload: {
      uiEvent: {
        'event.name': 'qwen-code.api_response',
        response_id: id,
        model: 'qwen3-coder-plus',
        input_token_count: input,
        output_token_count: 1,
        cached_content_token_count: 0,
      },
    },
  };
}

describe('scanAnalytics — архив Qwen Code', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-qwen-archive-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const chats = (project = 'c--work-qwen-demo'): string => join(home, 'projects', project, 'chats');
  function write(path: string, rows: unknown[]): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  }
  // Функцией: `home` назначается в beforeEach, после разбора describe.
  const options = (): ScanOptions => ({
    days: 30,
    recentSessionsLimit: 10,
    strictPricing: true,
    source: { kind: 'qwen', homes: [home] },
  });

  it('the same session in chats/ and chats/archive/ is counted once — from the live file', async () => {
    const ts = recent();
    // Живой файл — тот же журнал и продолжение: a1 + a2.
    write(join(chats(), 's1.jsonl'), [telemetry(ts, 'a1', 500), telemetry(ts, 'a2', 70)]);
    write(join(chats(), 'archive', 's1.jsonl'), [telemetry(ts, 'a1', 500)]);
    const result = await scanAnalytics(home, options());
    expect(result.scannedFiles).toBe(1);
    expect(result.overall).toMatchObject({ input: 570, requests: 2 });
  });

  it('an archived session alone counts; a same-named one in another project is another session', async () => {
    const ts = recent();
    write(join(chats(), 'archive', 's1.jsonl'), [telemetry(ts, 'a1', 500)]);
    write(join(chats('c--work-other'), 's1.jsonl'), [telemetry(ts, 'b1', 30)]);
    const result = await scanAnalytics(home, options());
    expect(result.scannedFiles).toBe(2);
    expect(result.overall).toMatchObject({ input: 530, requests: 2 });
  });
});
