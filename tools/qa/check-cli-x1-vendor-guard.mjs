/**
 * Ключ чужого CLI не уходит чужому вендору. Кейсы cli-x1-001.
 *
 * Без своего CLI в PATH чат чужого провайдера идёт прямым вызовом модельного API
 * его ключом (`assistant-runner/api.ts`). До 06.10 вид `openai-compat` без адреса
 * слал ключ на `OPENAI_BASE_URL ?? api.openai.com` (ключ Kimi — в OpenAI), а
 * Continue с видом `anthropic` молча становился чатом Claude. Теперь вызов без
 * адреса отказывает кодом `assistant-api-base-unknown` (юнит-тесты `api.test.ts`),
 * Kimi ходит только на адрес своего вендора (Moonshot), а у Continue своего API
 * нет (`apiKind: 'none'`) — без `cn` отказ раньше любого запроса.
 *
 * Настоящий экземпляр панели (`apps/server/src/index.ts`) на одноразовом доме,
 * без фронта и без единого CLI провайдера в PATH. Ключи — метки, не настоящие.
 * Две ловушки, обе — внешняя граница (сеть), не слой под проверкой:
 * - `OPENAI_BASE_URL` панели смотрит на свой HTTP-сервер проверки, он пишет
 *   метод, путь и заголовки каждого запроса;
 * - `NODE_OPTIONS=--import` подкладывает панели обёртку `fetch`: запрос на любой
 *   адрес вне 127.0.0.1 записывается и наружу НЕ уходит (ответ 599 на месте).
 * Свидетельство — записи ловушек, искомое — метка ключа в любом из них.
 *
 * Контроль живости ловушки: codex (вид `openai`, облако OpenAI — его вендор) тем
 * же путём ОБЯЗАН дойти до api.openai.com со своей меткой. Ловушка, не увидевшая
 * его, не доказывает и нуля у остальных.
 *
 * Запуск: `node tools/qa/check-cli-x1-vendor-guard.mjs [--server-dir <копия apps/server>]`.
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runOnStand, wait } from './throwaway-stand.mjs';

const serverAt = process.argv.indexOf('--server-dir');
const SERVER_DIR = serverAt > 0 ? process.argv[serverAt + 1] : undefined;

// Метки ключей: по ним ловушка узнаёт, чей ключ до неё дошёл.
const SENTINEL = {
  kimi: 'qa-x1-kimi-key-7Hq2',
  continue: 'qa-x1-anthropic-key-4Rm9',
  codex: 'qa-x1-openai-key-2Kd5',
};

// --- ловушка 1: адрес из OPENAI_BASE_URL -----------------------------------
const trapHits = [];
const trap = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    trapHits.push({ method: req.method, path: req.url, headers: req.headers, body: raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'TRAP_REPLY' } }] }));
  });
});
await new Promise((done) => trap.listen(0, '127.0.0.1', done));
const trapUrl = `http://127.0.0.1:${trap.address().port}/v1`;

// --- ловушка 2: любой fetch панели за пределы машины ------------------------
const work = mkdtempSync(join(tmpdir(), 'cc-x1-trap-'));
// `runOnStand` завершает процесс сам (`process.exit`), `finally` до этого не доходит.
process.once('exit', () => rmSync(work, { recursive: true, force: true }));
const offBoxLog = join(work, 'off-box.jsonl');
const preload = join(work, 'fetch-trap.mjs');
writeFileSync(
  preload,
  `import { appendFileSync } from 'node:fs';
const LOG = ${JSON.stringify(offBoxLog)};
const real = globalThis.fetch;
const headersOf = (h) => {
  if (!h) return {};
  if (typeof h.entries === 'function') return Object.fromEntries(h.entries());
  return { ...h };
};
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).hostname;
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') {
    return real(input, init);
  }
  appendFileSync(
    LOG,
    JSON.stringify({ url, headers: headersOf(init.headers), body: typeof init.body === 'string' ? init.body : '' }) + '\\n',
  );
  return new Response('{"error":"qa trap: off-box request"}', {
    status: 599,
    headers: { 'content-type': 'application/json' },
  });
};
`,
  'utf8',
);
const offBox = () =>
  existsSync(offBoxLog)
    ? readFileSync(offBoxLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

/** Где в записях ловушек лежит метка: «ловушка: адрес». */
const carriers = (sentinel) => [
  ...trapHits
    .filter((hit) => JSON.stringify(hit).includes(sentinel))
    .map((hit) => `OPENAI_BASE_URL-ловушка: ${hit.method} ${hit.path}`),
  ...offBox()
    .filter((hit) => JSON.stringify(hit).includes(sentinel))
    .map((hit) => `вне машины: ${hit.url.replace(/\?.*$/, '')}`),
];

await runOnStand(
  {
    label: 'cli-x1-vendor',
    web: false,
    noClaude: true,
    settings: { provider: 'kimi' },
    ...(SERVER_DIR ? { serverDir: SERVER_DIR } : {}),
    env: {
      KIMI_API_KEY: SENTINEL.kimi,
      ANTHROPIC_API_KEY: SENTINEL.continue,
      OPENAI_API_KEY: SENTINEL.codex,
      OPENAI_BASE_URL: trapUrl,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    },
  },
  async (stand, check) => {
    /** Один вопрос активному CLI; итог — последняя реплика разговора. */
    const ask = async (provider) => {
      if (provider !== 'kimi') {
        const switched = await stand.api('/settings', { method: 'PATCH', body: { provider } });
        check(`активный CLI → ${provider}`, switched.status === 200, switched.text.slice(0, 300));
      }
      const runner = await stand.api('/provider-runner');
      const created = await stand.api('/provider-chat/chats', { method: 'POST', body: {} });
      if (created.status !== 200) throw new Error(`разговор не создан: ${created.text}`);
      const id = created.body.id;
      const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
        method: 'POST',
        body: { text: `вопрос ${provider}` },
      });
      check(`${provider}: вопрос принят`, sent.status === 200, sent.text.slice(0, 300));
      for (let i = 0; i < 100; i += 1) {
        if ((await stand.api(`/provider-chat/chats/${id}/status`)).body?.isRunning === false) break;
        await wait(150);
      }
      const chat = (await stand.api(`/provider-chat/chats/${id}`)).body;
      const last = chat?.messages?.at(-1);
      return { runner: runner.body, last };
    };

    // Kimi знает адрес своего вендора (`apiBaseUrl` — Moonshot): его ключ ОБЯЗАН
    // дойти туда и только туда — ни в `OPENAI_BASE_URL`, ни в чужое облако.
    console.log('\nkimi: CLI нет в PATH, ключ-метка в окружении, адрес вендора известен');
    const kimi = await ask('kimi');
    check(
      `kimi: CLI в PATH не найден (раннер ${kimi.runner?.mode}/${kimi.runner?.reason})`,
      kimi.runner?.cliFound === false,
      JSON.stringify(kimi.runner).slice(0, 300),
    );
    const kimiSeen = carriers(SENTINEL.kimi);
    check(
      `kimi: метка ключа дошла до api.moonshot.ai (${kimiSeen.length})`,
      kimiSeen.some((where) => where.includes('api.moonshot.ai')),
      `${kimiSeen.join('; ')} | ${JSON.stringify(kimi.last).slice(0, 300)}`,
    );
    check(
      'kimi: метка ключа не ушла никуда, кроме api.moonshot.ai',
      kimiSeen.every((where) => where.startsWith('вне машины: https://api.moonshot.ai/')),
      kimiSeen.join('; '),
    );
    check(
      'kimi: ответ ловушки OPENAI_BASE_URL в разговор не попал',
      !String(kimi.last?.content).includes('TRAP_REPLY'),
      JSON.stringify(kimi.last).slice(0, 300),
    );

    // Continue своего API не имеет вовсе (`apiKind: 'none'`): без `cn` отказ
    // раньше любого запроса, ключ Anthropic не уходит никуда.
    console.log('\ncontinue: CLI нет в PATH, ключ Anthropic в окружении');
    const cont = await ask('continue');
    check(
      `continue: раннер без пути (${cont.runner?.mode}/${cont.runner?.reason})`,
      cont.runner?.cliFound === false && cont.runner?.mode === 'none',
      JSON.stringify(cont.runner).slice(0, 300),
    );
    check(
      'continue: ответ — отказ, не чат Claude и не ответ ловушки',
      cont.last?.role === 'assistant' &&
        cont.last?.failed === true &&
        !String(cont.last?.content).includes('TRAP_REPLY'),
      JSON.stringify(cont.last).slice(0, 400),
    );
    const contLeaked = carriers(SENTINEL.continue);
    check(
      'continue: метка ключа не дошла ни до одной ловушки (0)',
      contLeaked.length === 0,
      contLeaked.join('; '),
    );

    console.log('\ncodex: контроль живости ловушки (облако OpenAI — его вендор)');
    const control = await ask('codex');
    const seen = carriers(SENTINEL.codex);
    check(
      `codex: метка ключа дошла до api.openai.com через ловушку (${seen.length})`,
      seen.some((where) => where.includes('api.openai.com')),
      `${seen.join('; ')} | ${JSON.stringify(control.last).slice(0, 300)}`,
    );
    check(
      'codex: OPENAI_BASE_URL не перехватил облако OpenAI',
      !seen.some((where) => where.startsWith('OPENAI_BASE_URL')),
      seen.join('; '),
    );

    console.log(
      `\nловушка OPENAI_BASE_URL: ${trapHits.length} запрос(ов); вне машины: ${offBox().length}`,
    );
    check(
      'ни одной записи ловушки OPENAI_BASE_URL за весь прогон',
      trapHits.length === 0,
      trapHits.map((hit) => `${hit.method} ${hit.path}`).join('; '),
    );
  },
);
