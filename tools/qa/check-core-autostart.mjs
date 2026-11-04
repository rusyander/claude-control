/**
 * Тумблер «автозапуск ядра при входе» (этап 10, P57) — настоящая дорога на Windows: одноразовая
 * панель с ядром от надзора, `POST /api/core/supervisor/autostart` → команда ядра
 * `keepalive install|remove|status` → Планировщик заданий ОС. Чтение назад — сам Планировщик
 * (`schtasks /Query /XML`), не ответ панели.
 *
 * Запись человека не трогается: имя записи стенда своё, случайное (`AGENTDECK_CORE_AUTOSTART_NAME`),
 * снимается в конце при любом исходе.
 *
 * Что проверяется:
 * 1. До включения записи нет: надзор говорит `off`, Планировщик задачи не знает.
 * 2. Неверное тело (`on: "yes"`) — 400, записи не появилось.
 * 3. Включить — 200 `on`; задача в Планировщике запускает вход ядра с ДОМОМ стенда, при входе в
 *    систему; `/api/core/supervisor` → `autostart: on`.
 * 4. Выключить — 200 `off`; Планировщик задачи больше не знает.
 *
 * Красный прогон: `SUPERVISE=0` — ядро запускает сам стенд, надзора у панели нет (как до этапа 10):
 * маршрут отвечает 409, записи в Планировщике нет, строки 1, 3 и 4 краснеют.
 *
 * Только Windows: Linux (юнит systemd --user) и macOS (LaunchAgent) — набор
 * `apps/core/src/platform/keepalive*.test.ts`, на Linux через `tools/core-linux.mjs`.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не Windows / стенд не поднялся.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { NotChecked, runOnStand } from './throwaway-stand.mjs';

const supervise = process.env.SUPERVISE ?? '1';
const name = `agentdeck-core-qa-${randomBytes(4).toString('hex')}`;
const schtasks = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');

/** Задача Планировщика по имени: XML (UTF-16 у schtasks отдаётся как текст консоли) или null. */
function queryTask() {
  const r = spawnSync(schtasks, ['/Query', '/TN', name, '/XML'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return r.status === 0 ? r.stdout : null;
}

function removeTask() {
  spawnSync(schtasks, ['/Delete', '/TN', name, '/F'], { windowsHide: true });
}

if (process.platform !== 'win32') {
  console.log('Не проверено: живая проверка Планировщика — только Windows');
  process.exit(2);
}
process.once('exit', () => {
  if (queryTask() !== null) removeTask();
});

await runOnStand(
  {
    label: 'core-autostart',
    web: false,
    core: supervise === '1' ? { supervised: true } : true,
    env: { AGENTDECK_CORE_AUTOSTART_NAME: name },
  },
  async (stand, check) => {
    if (process.platform !== 'win32') throw new NotChecked('не Windows');
    const status = () => stand.api('/core/supervisor').then((r) => r.body);
    const toggle = (on) =>
      stand.api('/core/supervisor/autostart', { method: 'POST', body: { on } });

    // 1. До включения.
    const before = await status();
    check(
      `до включения: надзор — autostart ${before?.autostart}, в Планировщике задачи ${name} нет`,
      before?.autostart === 'off' && queryTask() === null,
      JSON.stringify(before),
    );

    // 2. Неверное тело.
    const bad = await toggle('yes');
    check(
      `on: "yes" — отказ 400 (${bad.status}), записи нет`,
      bad.status === 400 && queryTask() === null,
      bad.text,
    );

    // 3. Включить.
    const on = await toggle(true);
    const xml = queryTask() ?? '';
    check(
      `включить — ${on.status} ${JSON.stringify(on.body)}`,
      on.status === 200 && on.body?.ok === true && on.body?.state === 'on',
      on.text,
    );
    check(
      'Планировщик: задача есть, запускает вход ядра с домом стенда при входе в систему',
      xml.includes('LogonTrigger') &&
        xml.includes(stand.coreHome) &&
        /apps[\\/]core[\\/]src[\\/]index\.ts/.test(xml),
      xml.slice(0, 1500),
    );
    const afterOn = await status();
    check(
      `надзор видит включённый автозапуск (${afterOn?.autostart})`,
      afterOn?.autostart === 'on',
    );

    // 4. Выключить.
    const off = await toggle(false);
    check(
      `выключить — ${off.status} ${JSON.stringify(off.body)}, в Планировщике задачи нет`,
      off.status === 200 && off.body?.state === 'off' && queryTask() === null,
      off.text,
    );
  },
);
