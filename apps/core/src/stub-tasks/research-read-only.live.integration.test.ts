import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import {
  RESEARCH_EDIT_TARGET,
  RESEARCH_READ_MARK,
  RESEARCH_READ_ONLY,
} from './__fixtures__/library/stage11-f.ts';
import { BASE_REPO } from './__fixtures__/library/index.ts';
import {
  configFor,
  hasCli,
  journalOf,
  jsonLines,
  makeStand,
  runCore,
  sweepStand,
  type Stand,
} from './__fixtures__/e2e/stand.ts';

/**
 * Разведка только читает (P73, W2-7) — на НАСТОЯЩЕМ `claude`, модель — заглушка ядра
 * (`packages/stub-model`), ядро — отдельный процесс с одноразовым домом. Два замка:
 * - набор вида шага, как в продукте (`tools: 'by-step'`): CLI не объявляет модели запись, правку
 *   и оболочку — первый замок, флаги CLI;
 * - CLI, у которого флаг не удержал (`tools: 'all'`): модель пишет файл копии, хук ядра отпускает
 *   вызов дальше, CLI спрашивает право, дорога права ядра (`agentdeck-permit`, вид шага из
 *   журнала) отказывает `read-only-step` — второй замок; файл копии цел, чтение README доходит.
 * Нет CLI в PATH — прогон пропускается и называет причину.
 */

const present = hasCli(claudeRunFacts.binary.command);
const stands: Stand[] = [];
afterAll(async () => {
  for (const s of stands) await sweepStand(s);
}, 120_000);

const task = (id: string) => RESEARCH_READ_ONLY.find((t) => t.id === id)!;

/**
 * Запросы главного цикла CLI к модели (с объявленным `Read`): служебные запросы без инструментов
 * мимо. Строка следа заглушки — `kind:'model'`, тело запроса в `body` (без полей доступа).
 */
function loopRequests(s: Stand): { tools: string[]; raw: string }[] {
  return jsonLines(s.trace)
    .filter((r) => r.kind === 'model')
    .map((r) => {
      const body = (r.body ?? {}) as { tools?: { name?: string }[] };
      return {
        tools: (body.tools ?? []).map((t) => String(t.name)),
        raw: JSON.stringify(body),
      };
    })
    .filter((r) => r.tools.includes('Read'));
}

describe.skipIf(!present)('research step on the real claude CLI: read-only holds (P73)', () => {
  it('the product tool set: the model sees Read and no Write, Edit or Bash; the step is claimed', async () => {
    const s = makeStand(task('research-tools-read-only'), 'e2e-research-tools-');
    stands.push(s);
    const run = await runCore(s, configFor(s, 'claude', 'claimed', { tools: 'by-step' }));
    expect(run.code, run.stderr.slice(-3000)).toBe(0);
    expect(run.result?.outcome, JSON.stringify(run.notes)).toBe('claimed');
    const requests = loopRequests(s);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests)
      for (const denied of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'])
        expect(r.tools, denied).not.toContain(denied);
    expect(requests.some((r) => r.raw.includes(RESEARCH_READ_MARK))).toBe(true);
  }, 300_000);

  it('a CLI whose flag did not hold: the write is refused read-only-step on the permit road, the file stays, the read passes', async () => {
    const s = makeStand(task('research-edit-refused'), 'e2e-research-edit-');
    stands.push(s);
    const run = await runCore(s, configFor(s, 'claude', 'claimed', { tools: 'all' }));
    expect(run.code, run.stderr.slice(-3000)).toBe(0);
    expect(run.result?.outcome, JSON.stringify(run.notes)).toBe('claimed');
    const result = run.result!;
    // Копия: файл базы тот же байт в байт — запись не дошла до диска.
    expect(readFileSync(join(result.copy, RESEARCH_EDIT_TARGET), 'utf8')).toBe(
      BASE_REPO.files[RESEARCH_EDIT_TARGET],
    );
    type Out = { allow: boolean; code?: string; tool?: string; road?: string };
    const permits = journalOf(s, result.taskId)
      .filter((l) => l.kind === 'decision' && (l.data as { class: string }).class === 'permit')
      .map((l) => (l.data as unknown as { output: Out }).output);
    // Хук ядра вида шага не знает (`decidePermit` без `stepKind`) и отпускает вызов дальше
    // обычной дорогой права; судит вопрос CLI инструментом `agentdeck-permit` — он и отказывает.
    const asked = permits.filter((o) => o.tool === 'Write' && o.road !== 'hook');
    expect(asked.length, JSON.stringify(permits)).toBeGreaterThan(0);
    for (const o of asked) expect(o).toMatchObject({ allow: false, code: 'read-only-step' });
    // Отказ дошёл до модели результатом вызова, а не потерялся между CLI и ядром.
    const loop = loopRequests(s);
    expect(loop.some((r) => r.raw.includes('step kind research is read-only'))).toBe(true);
    // Чтение не отказано ни разу, и его результат (метка README) дошёл до модели.
    expect(permits.filter((o) => o.tool === 'Read' && !o.allow)).toEqual([]);
    expect(loop.some((r) => r.raw.includes(RESEARCH_READ_MARK))).toBe(true);
  }, 300_000);
});
