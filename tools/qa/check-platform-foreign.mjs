/**
 * Универсальность драйвера `openai-compat` (Т12) — на ЧУЖОМ шлюзе.
 *
 * Почему эта проверка вообще существует. Драйвер совместимого шлюза до сих пор
 * проверялся только на заглушках, написанных здесь же, — то есть на нашем
 * собственном представлении о том, как отвечает совместимый шлюз. Это
 * доказывает наши тесты, а не универсальность. Здесь под панелью стоит Ollama:
 * чужая реализация OpenAI-совместимого `/v1`, с её собственными полями,
 * заголовками и формой потока.
 *
 * Что прогоняется целиком, без подмен внутри:
 *   1. проба контура на чужом адресе — список моделей приходит, остальные
 *      возможности остаются «не объявлено» и НЕ превращаются ни в галку, ни в
 *      прочерк;
 *   2. запрос через локальный шлюз панели (`/<id>/v1/chat/completions`) —
 *      живой ответ живой модели, потоком;
 *   3. не-потоковый вызов, переведённый шлюзом в потоковый (`forceStream`);
 *   4. учёт расхода: запрос попал в дневной итог контура;
 *   5. отказ чужого шлюза на неизвестной модели назван человеческой причиной;
 *   6. ассистент панели, применённый к контуру, отвечает через него.
 *
 * СВИДЕТЕЛЬ НА ПРОВОДЕ. Между панелью и Ollama стоит крошечный прокси, который
 * НИЧЕГО не подменяет: он записывает уходящий запрос и передаёт его дальше как
 * есть. Без него две проверки были бы украшением — «не-потоковый вызов собрался
 * в один ответ» верно и тогда, когда шлюз наверх сходил обычным запросом, а
 * весь смысл `forceStream` в том, что наверх он идёт ПОТОКОМ. Он же — то
 * единственное место, где видно, каким заголовком уходит ключ: сама Ollama
 * ключей не проверяет и о них не рассказывает.
 *
 * Панель поднимается СВОЯ, одноразовая: каталог конфигурации во временной
 * папке, свой порт. Рабочий стенд человека при этом не трогается — ни его
 * контуры, ни настройка его шлюза.
 *
 * Запуск: `node tools/qa/check-platform-foreign.mjs`
 * Нужен установленный Ollama и хотя бы одна модель (`ollama pull qwen2.5:0.5b`).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const PANEL_PORT = Number(process.env.FOREIGN_PANEL_PORT ?? 5188);
const GATEWAY_PORT = Number(process.env.FOREIGN_GATEWAY_PORT ?? 5189);
const WITNESS_PORT = Number(process.env.FOREIGN_WITNESS_PORT ?? 5190);
const WITNESS = `http://127.0.0.1:${WITNESS_PORT}`;
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const CONTOUR = 'foreign-openai';

/**
 * Заглушка вместо ключа. Ollama проверки ключа не делает вовсе, а панель без
 * ключа считает контур неподключённым — строка нужна только ради этого.
 * Собирается из кусков намеренно: секрет-подобных присваиваний в файлах
 * репозитория не держим даже понарошку.
 */
const FOREIGN_KEY = process.env.FOREIGN_KEY ?? ['ollama', 'no', 'key', 'needed'].join('-');

/** Что уходило наверх, в порядке отправки. Пишет свидетель, читают проверки. */
const upstreamSeen = [];

/**
 * Свидетель на проводе: передаёт запрос в Ollama как есть и записывает его.
 *
 * Именно ПЕРЕДАЁТ, а не отвечает сам: отвечает всегда настоящая Ollama, иначе
 * проверка снова доказывала бы наши представления о совместимом шлюзе. Поток
 * идёт кусками по мере прихода — собранное тело убило бы проверку потока.
 */
function startWitness() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        parsed = undefined;
      }
      upstreamSeen.push({
        path: req.url,
        stream: parsed?.stream,
        auth: req.headers.authorization ?? '',
        accept: req.headers.accept ?? '',
      });

      void (async () => {
        try {
          const upstream = await fetch(`${OLLAMA}${req.url}`, {
            method: req.method,
            headers: {
              'content-type': 'application/json',
              accept: req.headers.accept ?? '*/*',
            },
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
          });
          res.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'application/json',
          });
          if (upstream.body) {
            for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
          }
          res.end();
        } catch (error) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(error) }));
        }
      })();
    });
  });
  server.listen(WITNESS_PORT, '127.0.0.1');
  return server;
}

/** Последний ушедший наверх запрос к названному пути. */
const lastUpstream = (path) => [...upstreamSeen].reverse().find((item) => item.path === path);

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n    ${detail}`);
};
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));

/** Ждём, пока адрес начнёт отвечать. Чужой шлюз стартует не мгновенно. */
async function waitFor(url, seconds, init) {
  for (let i = 0; i < seconds * 4; i += 1) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
    } catch {
      // ещё не поднялся
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

async function api(path, init = {}) {
  const res = await fetch(`${PANEL}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const started = [];

/**
 * Выход, которому нельзя проскочить мимо уборки.
 *
 * `process.exit` внутри `try` не даёт отработать `finally`, и одноразовая панель
 * вместе с поднятым `ollama serve` пережила бы прогон, заняв порт до конца
 * сеанса. Поэтому «не проверено» бросается, а не выходит.
 */
class NotChecked extends Error {}

async function main() {
  // ── Чужой шлюз ───────────────────────────────────────────────────────────
  let models = await waitFor(`${OLLAMA}/v1/models`, 2);
  if (!models) {
    console.log('Ollama не отвечает — запускаю сервер.');
    const serve = spawn('ollama', ['serve'], { stdio: 'ignore', detached: false, shell: true });
    started.push(serve);
    models = await waitFor(`${OLLAMA}/v1/models`, 30);
  }
  if (!models) {
    throw new NotChecked(`чужой шлюз не поднялся на ${OLLAMA}.`);
  }

  const catalog = await models.json();
  const model = catalog.data?.[0]?.id;
  if (!model) {
    throw new NotChecked('у чужого шлюза нет ни одной модели (ollama pull qwen2.5:0.5b).');
  }
  console.log(`Чужой шлюз: ${OLLAMA}, модель ${model}\n`);

  // ── Одноразовая панель ───────────────────────────────────────────────────
  const home = mkdtempSync(join(tmpdir(), 'cc-foreign-'));
  mkdirSync(join(home, 'agentdeck'), { recursive: true });
  writeFileSync(join(home, 'settings.json'), '{}\n', 'utf8');
  writeFileSync(join(home, 'CLAUDE.md'), '# проверка\n', 'utf8');

  const witness = startWitness();

  const panel = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
    {
      env: { ...process.env, CLAUDE_CONFIG_DIR: home, PORT: String(PANEL_PORT) },
      stdio: 'ignore',
      shell: false,
    },
  );
  started.push(panel);

  try {
    if (!(await waitFor(`${PANEL}/api/system`, 30))) {
      throw new NotChecked('одноразовая панель не поднялась.');
    }

    await run(model, home);
  } finally {
    for (const child of started) child.kill();
    witness.close();
    rmSync(home, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nВсё сходится.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function run(model, home) {
  // ── 1. Проба чужого шлюза ────────────────────────────────────────────────
  const saved = await api(`/platforms/${encodeURIComponent(CONTOUR)}`, {
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        id: CONTOUR,
        title: 'Ollama как совместимый шлюз',
        driver: 'openai-compat',
        // Адрес свидетеля, а не самой Ollama: он передаёт запрос ей как есть и
        // при этом даёт увидеть, что именно ушло наверх.
        baseUrl: WITNESS,
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
      token: FOREIGN_KEY,
    }),
  });
  check(
    'контур на произвольном адресе сохраняется',
    saved.status === 200,
    JSON.stringify(saved.body),
  );

  const probe = await api(`/platforms/${encodeURIComponent(CONTOUR)}/check`, {
    method: 'POST',
    body: '{}',
  });
  const health = probe.body?.health ?? probe.body;
  check('проба чужого шлюза прошла', health?.outcome === 'ok', JSON.stringify(probe.body));
  check(
    'модели чужого шлюза прочитаны',
    Array.isArray(health?.models) && health.models.length > 0,
    `моделей: ${health?.models?.length}`,
  );

  const byId = Object.fromEntries((health?.capabilities ?? []).map((item) => [item.id, item]));
  check(
    'список моделей — подтверждённая возможность',
    byId.models?.state === 'yes',
    JSON.stringify(byId.models),
  );
  check(
    'чат у совместимого шлюза НЕ объявлен галкой',
    byId.chat?.state === 'unknown' && byId.chat?.compromise === 'probe-guess',
    JSON.stringify(byId.chat),
  );
  check(
    'знания и инструменты клиента тоже не выдуманы',
    byId.knowledge?.state === 'unknown' && byId['client-tools']?.state === 'unknown',
    JSON.stringify([byId.knowledge, byId['client-tools']]),
  );

  // Ключ уходит ровно одним заголовком и ровно в той форме, какую объявляет
  // драйвер. Сама Ollama про ключи ничего не рассказывает — увидеть это можно
  // только на проводе.
  const probeSeen = lastUpstream('/v1/models');
  check(
    'ключ ушёл заголовком драйвера, и только им',
    probeSeen?.auth === `Bearer ${FOREIGN_KEY}`,
    JSON.stringify(probeSeen),
  );

  // ── 2. Шлюз панели над чужим шлюзом ──────────────────────────────────────
  const settings = await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      platformGateway: { enabled: true, port: GATEWAY_PORT, forceStream: true },
    }),
  });
  check('шлюз панели включён', settings.status === 200, JSON.stringify(settings.body));

  const restarted = await api('/platforms/gateway/restart', { method: 'POST', body: '{}' });
  const port = restarted.body?.status?.port ?? GATEWAY_PORT;
  check(
    'слушатель поднялся и знает маршрут чужого контура',
    restarted.body?.status?.running === true &&
      restarted.body?.status?.routes?.some((route) => route.platformId === CONTOUR && route.ready),
    JSON.stringify(restarted.body),
  );

  const base = `http://127.0.0.1:${port}/${encodeURIComponent(CONTOUR)}/v1`;

  const streamed = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Ответь одним словом: привет' }],
    }),
  });
  const streamText = await streamed.text();
  check(
    'чужой шлюз ответил через шлюз панели потоком',
    streamed.status === 200,
    `${streamed.status}: ${streamText.slice(0, 200)}`,
  );
  check(
    'в потоке есть содержимое ответа',
    streamText.includes('data:') && /"content"\s*:\s*"[^"]/.test(streamText),
    streamText.slice(0, 300),
  );

  // ── 3. Не-потоковый вызов ────────────────────────────────────────────────
  const plain = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Ответь одним словом: да' }],
    }),
  });
  const plainBody = await plain.json().catch(() => undefined);
  check(
    'не-потоковый вызов собран шлюзом обратно в один ответ',
    plain.status === 200,
    JSON.stringify(plainBody)?.slice(0, 300),
  );
  check(
    'у собранного ответа есть текст и учёт',
    Boolean(plainBody?.choices?.[0]?.message?.content) && Boolean(plainBody?.usage),
    JSON.stringify(plainBody)?.slice(0, 300),
  );
  // Без этой проверки две предыдущие — украшение: обычный ответ на обычный
  // запрос выглядит точно так же. Весь смысл `forceStream` в том, что НАВЕРХ
  // ушёл поток, потому что не-потоковый вызов контур рвёт на 120-й секунде.
  const plainSeen = lastUpstream('/v1/chat/completions');
  check(
    'наверх при этом ушёл ПОТОК, а не обычный запрос',
    plainSeen?.stream === true,
    JSON.stringify(plainSeen),
  );

  // ── 4. Учёт расхода ──────────────────────────────────────────────────────
  const listed = await api('/platforms');
  const card = listed.body?.platforms?.find((item) => item.platform.id === CONTOUR);
  check(
    'расход чужого шлюза попал в учёт контура',
    (card?.periodSpend?.requests ?? 0) >= 2,
    JSON.stringify(card?.periodSpend),
  );

  // ── 5. Отказ чужого шлюза ────────────────────────────────────────────────
  const missing = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'такой-модели-нет-нигде',
      messages: [{ role: 'user', content: 'привет' }],
    }),
  });
  const missingBody = await missing.text();
  // Чужой шлюз отвечает на неизвестную модель СВОИМ отказом (Ollama — 400
  // «invalid model name»), и панель обязана донести именно его. Ошибка,
  // свёрнутая в «нет связи», отправила бы человека чинить сеть.
  let missingReason;
  try {
    const parsed = JSON.parse(missingBody);
    missingReason = parsed?.error?.message ?? parsed?.message ?? '';
  } catch {
    missingReason = '';
  }
  // Хвост после нашей рамки — это и есть слова чужого шлюза. Проверяется он, а
  // не слово «model» где-нибудь в теле: имя поля запроса, отражённое обратно,
  // доказывало бы эхо, а не донесённую причину. Саму формулировку вендора не
  // закрепляем — она его, и меняться вправе.
  const foreignWords = missingReason.split(': ').pop() ?? '';
  check(
    'отказ чужого шлюза донесён его же причиной, а не «нет связи»',
    missing.status >= 400 &&
      missing.status < 500 &&
      missingReason.includes('Контур не принял запрос') &&
      foreignWords.trim().length >= 5 &&
      !/[А-Яа-я]/.test(foreignWords) &&
      !/Нет связи/.test(missingBody),
    `${missing.status}: ${missingBody.slice(0, 300)}`,
  );

  // ── 6. Ассистент панели поверх чужого шлюза ──────────────────────────────
  // Первый критерий приёмки Т12 требует не «шлюз отвечает», а «контур
  // ОБСЛУЖИВАЕТ АССИСТЕНТА». Это другой путь: применение заводит управляемый
  // профиль эндпоинта, и `/api/assistant/run` идёт по нему, а не в облако
  // вендора и не через подписочный CLI.
  const applied = await api(`/platforms/${encodeURIComponent(CONTOUR)}/apply`, {
    method: 'POST',
    body: JSON.stringify({ targets: ['assistant'], model }),
  });
  check(
    'контур применён к ассистенту панели',
    applied.status === 200 && applied.body?.applied?.some((item) => item.targetId === 'assistant'),
    JSON.stringify(applied.body)?.slice(0, 300),
  );

  const asked = await api('/assistant/run', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Ответь одним словом: да' }] }),
  });
  check(
    'ассистент панели ответил через чужой контур',
    asked.body?.ok === true && asked.body?.mode === 'api' && asked.body.reply.trim().length > 0,
    JSON.stringify(asked.body)?.slice(0, 300),
  );

  const afterAssistant = await api('/platforms');
  const cardAfter = afterAssistant.body?.platforms?.find((item) => item.platform.id === CONTOUR);
  check(
    'ответ ассистента тоже попал в учёт контура',
    (cardAfter?.periodSpend?.requests ?? 0) > (card?.periodSpend?.requests ?? 0),
    `${card?.periodSpend?.requests} → ${cardAfter?.periodSpend?.requests}`,
  );

  // Одноразовая панель живёт во временной папке — убирать за собой в её
  // состоянии незачем, но путь печатаем: он пригодится, если проверка упала.
  if (failures > 0) console.log(`\nСостояние одноразовой панели: ${home}`);
}

try {
  await main();
} catch (error) {
  if (!(error instanceof NotChecked)) throw error;
  // «Не проверено» — это не провал проверки и не зелёный прогон: отдельный код
  // выхода, чтобы гейт не принял отсутствие чужого шлюза за успех.
  console.log(`НЕ ПРОВЕРЕНО: ${error.message}`);
  process.exit(2);
}
