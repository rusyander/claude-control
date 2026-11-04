/**
 * Одно ядро на дом (этап 10): две панели, поднятые РАЗОМ на одном доме ядра, — у обеих надзор, ядра
 * ещё нет, — оставляют одно ядро. Обе надзирают его: тот же pid, состояние `up`, а не `fault` у
 * проигравшей (её ядро ушло на замке дома `core.lock`, `CoreHomeBusy`, и надзор усыновил победителя).
 * Через обе панели команда ядра проходит.
 *
 * Дорога настоящая: две одноразовые панели (`throwaway-stand`, `core: { supervised, home }`),
 * `launchCore` каждой, замок дома в ядре (`bootstrap/boot/home-lock.ts`). Подменены только дома.
 *
 * Красный прогон — мутант замка дома (замок всегда взят):
 *   node ~/.claude/tools/mustfail.mjs --cwd . --cmd "node tools/qa/check-core-one-per-home.mjs" \
 *     --mutate apps/core/src/bootstrap/boot/home-lock.ts --find "if (!outcome.acquired)" --replace "if (false)"
 *
 * Запуск: `node tools/qa/check-core-one-per-home.mjs`. Код выхода: 0 — сходится, 1 — провал,
 * 2 — стенд не поднялся.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CORE_STUBS,
  NotChecked,
  reapCoreSessions,
  reporter,
  startStand,
  wait,
} from './throwaway-stand.mjs';

const { check, finish } = reporter();
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-core-one-home-')));
writeFileSync(
  join(home, 'config.json'),
  `${JSON.stringify({ routes: { stub: DEFAULT_CORE_STUBS } }, null, 2)}\n`,
);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Живые строки ядер дома в `procs.json`. */
const liveCores = () => {
  try {
    const procs = JSON.parse(readFileSync(join(home, 'procs.json'), 'utf8'));
    return (procs.cores ?? []).filter((row) => alive(row.pid)).map((row) => row.pid);
  } catch {
    return [];
  }
};

const stands = [];
try {
  // Обе панели — одновременно: надзоры обеих видят «ядра нет» и поднимают по ядру.
  const options = (label) => ({ label, web: false, core: { supervised: true, home } });
  const started = await Promise.allSettled([
    startStand(options('core-home-a')),
    startStand(options('core-home-b')),
  ]);
  for (const got of started) if (got.status === 'fulfilled') stands.push(got.value);
  const lost = started.find((got) => got.status === 'rejected');
  if (lost) {
    if (lost.reason instanceof NotChecked) throw lost.reason;
    check('обе панели поднялись', false, lost.reason?.stack ?? String(lost.reason));
  }
  console.log(`Две одноразовые панели: ${stands.map((s) => s.apiUrl).join(', ')}\n`);
  if (stands.length === 2) {
    const [a, b] = stands;
    const status = (stand) =>
      stand
        .api('/core/supervisor')
        .then((r) => r.body)
        .catch(() => null);
    // Проигравшее ядро уходит на замке дома, надзор его панели переходит к победителю — дать время
    // осесть: обе стороны `up` с одним pid и так 5 с подряд.
    let both = [];
    let steady = 0;
    for (let i = 0; i < 120 && steady < 10; i += 1) {
      both = await Promise.all([status(a), status(b)]);
      const same =
        both.every((s) => s?.state === 'up') && both[0].pid === both[1].pid && alive(both[0].pid);
      steady = same ? steady + 1 : 0;
      await wait(500);
    }
    check(
      `обе панели надзирают одно ядро (pid ${both[0]?.pid} / ${both[1]?.pid}, ${both[0]?.state} / ${both[1]?.state})`,
      steady >= 10,
      JSON.stringify(both),
    );
    const cores = liveCores();
    check(
      `в доме одно живое ядро (procs.json: ${cores.join(', ') || '—'})`,
      cores.length === 1 && cores[0] === both[0]?.pid,
    );
    check(
      `у проигравшей панели не «сбой» (${both.map((s) => s?.state).join(' / ')})`,
      both.every((s) => s?.state !== 'fault'),
    );
    for (const [name, stand] of [
      ['A', a],
      ['B', b],
    ]) {
      const health = await stand.api('/core/health');
      check(
        `ядро отвечает через панель ${name} (/api/core/health ${health.status})`,
        health.status === 200,
      );
    }
  }
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    for (const stand of stands) await stand.stop();
    process.exitCode = 2;
  } else check('сценарий дошёл до конца', false, error?.stack ?? String(error));
} finally {
  for (const stand of stands) await stand.stop();
  // Дом общий, чужой для обоих стендов — ядро и его процессы снимаются здесь.
  reapCoreSessions(home);
  await wait(1_000);
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (error) {
    console.log(`дом ядра ${home} не удалён: ${error.message}`);
  }
}
if (process.exitCode !== 2) finish();
