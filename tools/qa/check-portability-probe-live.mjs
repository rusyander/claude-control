/**
 * ПРИЁМОЧНАЯ ПРОБА НА НАСТОЯЩИХ CLI — третий этаж §9 плана переноса.
 *
 * `check-portability-probe.mjs` держит дорогу пробы на ПОДДЕЛЬНОМ CLI и умеет
 * краснеть без единой установки. Здесь — то, чего подделка не скажет: ведёт ли
 * себя установленный CLI человека так, как обещает отчёт верности. Одноразовая
 * панель, `POST /api/portability/probe` на обоих уровнях, настоящий бинарь.
 *
 * Красное — любое из:
 *  - строка `mismatch`: обещали одно, CLI сделал другое (дефект переноса);
 *  - CLI не найден в PATH панели;
 *  - прогон до модели не дошёл (`run_failed`, `timed_out`, `emit_failed`,
 *    `no_stub_endpoint`, `no_one_shot`): «не проверено» здесь значило бы, что
 *    проба промолчала ровно там, где её спрашивали.
 * Честное «не проверено» (`no_probe_recipe`, `needs_panel_runtime`,
 * `target_reads_real_home` и т.п.) — не красное: это названная граница пробы.
 *
 * Живая проба 09.10.2026 нашла этим прогоном шесть дефектов у OpenCode и
 * Continue (docs/TASKS-PORTABILITY.ru.md §9.1).
 *
 * Запуск: `node tools/qa/check-portability-probe-live.mjs <cli> [<cli> …]`
 * (например `opencode continue`). Нужны установленные CLI; модель не нужна —
 * её играет заглушка пробы. Каталоги CLI человека не трогаются: проба пишет
 * только во временный дом.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runOnStand } from './throwaway-stand.mjs';

const targets = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (targets.length === 0) {
  console.error('Укажите CLI: node tools/qa/check-portability-probe-live.mjs opencode continue');
  process.exit(2);
}

/** Пробег, не дошедший до модели: «не проверено» тут — молчание пробы, а не граница. */
const SILENT = new Set([
  'run_failed',
  'timed_out',
  'emit_failed',
  'no_stub_endpoint',
  'no_one_shot',
]);

// Установщики uv и goose кладут бинарь в `~/.local/bin`, а уже открытая
// оболочка о нём не знает до перезапуска; npm — в свой глобальный каталог.
const extraPath = [
  join(homedir(), '.local', 'bin'),
  ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm')] : []),
].filter((dir) => existsSync(dir));

await runOnStand({ web: false, label: 'probe-live', extraPath }, async (stand, check) => {
  for (const target of targets) {
    for (const scope of ['global', 'project']) {
      const res = await stand.api('/portability/probe', {
        method: 'POST',
        body: { target, scope },
      });
      const report = res.body?.report;
      console.log(`\n${target}/${scope}: HTTP ${res.status}, бинарь ${report?.cliCommand ?? '—'}`);
      if (res.status !== 200) console.log(`   ${String(res.text ?? '').slice(0, 300)}`);
      for (const row of report?.rows ?? []) {
        console.log(
          `   ${row.verdict.padEnd(11)} ${row.layer.padEnd(10)} обещано ${row.promised}, ` +
            `ждали ${row.expected}, видели ${row.observed}` +
            `${row.skip ? ` (${row.skip})` : ''}${row.detail ? ` — ${String(row.detail).slice(0, 80)}` : ''}`,
        );
      }
      check(`${target}/${scope}: проба ответила`, res.status === 200);
      check(`${target}/${scope}: CLI найден`, report?.cliInstalled === true);
      const rows = report?.rows ?? [];
      const mismatched = rows.filter((row) => row.verdict === 'mismatch').map((row) => row.layer);
      check(
        `${target}/${scope}: обещания сходятся с поведением`,
        mismatched.length === 0,
        mismatched.join(', '),
      );
      const silent = rows
        .filter((row) => SILENT.has(row.skip))
        .map((row) => `${row.layer}:${row.skip}`);
      check(`${target}/${scope}: прогон дошёл до модели`, silent.length === 0, silent.join(', '));
    }
  }
});
