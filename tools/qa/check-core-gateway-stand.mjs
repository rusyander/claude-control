/**
 * Шлюз контуров на одноразовом стенде (этап 10, зона C, проход 5): шлюз человека держит ядро, и
 * на машине человека ядро на доме `~/.agentdeck/core` слушает порт из настроек панели всегда —
 * включён тумблер шлюза или нет. Ядро стенда живёт на своём доме и шлюза не открывает, пока порт не
 * задан явно (`AGENTDECK_USER_GATEWAY_PORT`, `userGatewayPlanOf` ядра). Стенд передавал порт только
 * при шлюзе, включённом в засеве, а мастер контура включает шлюз уже на ходу — ядро стенда так и не
 * поднимало шлюз, карточка говорила «Шлюз панели не поднят» (`gateway-view.ts`, gateway-core-unknown),
 * кадры мастера не снимались.
 *
 * Дорога настоящая: панель стенда → прокладка → ядро → хост звеньев, засев по умолчанию (шлюз
 * выключен), контур заведён через API панели, «Поднять шлюз» — тем же `POST
 * /api/platforms/gateway/start`, что мастер и активация. Подменены только дома (временные).
 *
 * Что проверяется — для ядра под надзором панели и для ядра, которое поднял сам стенд:
 * 1. Контур заведён (PUT /api/platforms/:id — 200).
 * 2. «Поднять шлюз» — 200, `status.running`, порт = порт из настроек стенда, без ошибки.
 * 3. GET /api/platforms/gateway: шлюз up, маршрут контура назван с этим портом.
 * 4. Порт в самом деле слушает: запрос на маршрут контура получает HTTP-ответ, а не отказ соединения.
 *
 * Запуск: `node tools/qa/check-core-gateway-stand.mjs [--core=supervised|own]` (без флага — оба).
 * Код выхода: 0 — сходится, 1 — провал, 2 — стенд не поднялся.
 */
import { startStand, wait } from './throwaway-stand.mjs';

const CONTOUR = 'stand-gw';
const coreArg = process.argv.slice(2).find((a) => a.startsWith('--core='));
const modes = coreArg ? [coreArg.slice('--core='.length)] : ['supervised', 'own'];
if (modes.some((m) => m !== 'supervised' && m !== 'own')) {
  console.log(`Не проверено: неизвестный режим ядра ${coreArg} (supervised | own)`);
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};

for (const mode of modes) {
  console.log(`\nЯдро ${mode === 'supervised' ? 'под надзором панели' : 'от стенда'}:`);
  let stand;
  try {
    stand = await startStand({
      label: `core-gateway-${mode}`,
      web: false,
      core: mode === 'supervised' ? { supervised: true } : true,
    });
  } catch (error) {
    console.log(`Стенд не поднялся: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  try {
    if (mode === 'supervised') {
      for (let i = 0; i < 200; i += 1) {
        const s = await stand.api('/core/supervisor').catch(() => null);
        if (s?.body?.state === 'up') break;
        await wait(300);
      }
    }
    const settings = (await stand.api('/settings')).body;
    const wanted = (settings.settings ?? settings).platformGateway.port;
    const put = await stand.api(`/platforms/${CONTOUR}`, {
      method: 'PUT',
      body: {
        settings: {
          id: CONTOUR,
          title: 'Контур стенда',
          driver: 'enterprise-platform',
          baseUrl: 'http://127.0.0.1:9/v1',
          enabled: true,
          mode: 'best-effort',
          budgetUsd: 0,
          budgetSince: '',
          capabilities: [],
          targets: [],
          projectPaths: [],
          agents: [],
          caCertPath: '',
        },
        token: 'stand-key',
      },
    });
    check(`контур заведён (PUT ${put.status})`, put.status === 200, put.text.slice(0, 300));

    const started = await stand.api('/platforms/gateway/start', { method: 'POST', body: {} });
    const status = started.body?.status;
    check(
      `«Поднять шлюз» — 200, шлюз слушает порт стенда ${wanted}`,
      started.status === 200 && status?.running === true && status.port === wanted && !status.error,
      `${started.status} ${started.text.slice(0, 400)}`,
    );

    const info = (await stand.api('/platforms/gateway')).body;
    const route = info?.status?.routes?.find((r) => r.platformId === CONTOUR);
    check(
      'карточка шлюза: up, маршрут контура на этом порту, ошибки нет',
      info?.status?.running === true &&
        !info.status.error &&
        route?.address === `http://127.0.0.1:${wanted}/${CONTOUR}/v1`,
      JSON.stringify({ running: info?.status?.running, error: info?.status?.error, route }),
    );

    /** Ответ шлюза на маршрут: `HTTP <код> <начало тела>` или причина, по которой его нет. */
    const ask = async (contour) => {
      try {
        const res = await fetch(`http://127.0.0.1:${wanted}/${contour}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
          signal: AbortSignal.timeout(20_000),
        });
        return `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`;
      } catch (error) {
        return `нет ответа: ${error instanceof Error ? (error.cause?.code ?? error.message) : error}`;
      }
    };
    const known = await ask(CONTOUR);
    const unknown = await ask('no-such-contour');
    // Шлюз знает контур: незаведённый отвечает «не заведён» (404), а маршрут контура до этого
    // слова не доходит — верх контура по адресу :9 недоступен, и это уже ответ звена про верх.
    const NOT_FOUND = /не заведён|not set up|not_found_error/;
    check(
      'порт шлюза слушает, маршрут контура заведён у шлюза (чужой — «не заведён»)',
      known.startsWith('HTTP ') && !NOT_FOUND.test(known) && NOT_FOUND.test(unknown),
      `контур: ${known}\n    чужой: ${unknown}`,
    );
  } finally {
    await stand.stop();
  }
}

console.log(failures === 0 ? '\nВсё сходится.' : `\nПровалов: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
