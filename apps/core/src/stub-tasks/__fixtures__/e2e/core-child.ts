// Процесс ядра сквозного прогона: загрузка на доме из настройки (base64url JSON в argv[2]) →
// дирижёр фазы 2 (`conduct.ts`) → строка `RESULT <json>` в файл итога → чистая остановка.
// Точка смерти из настройки убивает процесс без чистой остановки (крах ядра, P10).
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootCore } from '../../../bootstrap/boot.ts';
import { conduct } from './conduct.ts';
import type { ChildLaunch } from './e2e.types.ts';

const raw = process.argv[2];
if (!raw) throw new Error('usage: core-child.ts <base64url config>');
const cfg = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as ChildLaunch;
const out = join(cfg.home, '..');
const notes = join(out, 'conduct.jsonl');
const killLog = join(out, 'kill.jsonl');
const note = (event: string, data: Record<string, unknown> = {}): void => {
  appendFileSync(
    notes,
    `${JSON.stringify({ at: Date.now(), pid: process.pid, runId: cfg.runId, event, ...data })}\n`,
  );
};

// Задачу стенда ведёт `conduct` (свой исполнитель над той же дорогой): исполнитель продукта
// подхватил бы ту же запущенную задачу вторым.
const core = await bootCore({
  home: cfg.home,
  build: 'stub-e2e',
  loop: false,
  ...(cfg.observer ? { observer: cfg.observer } : {}),
});
note('boot', { url: core.url });
try {
  const result = await conduct(core, cfg, note, killLog);
  writeFileSync(join(out, `result-${cfg.runId}.json`), JSON.stringify(result));
  note('result', { outcome: result.outcome });
} catch (error) {
  note('error', { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  process.exitCode = 3;
} finally {
  await core.stop();
  note('stopped');
}
