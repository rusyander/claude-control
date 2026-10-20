/**
 * Живое доказательство 2.1 плана экономии: сжатие группы на настоящем `claude`.
 *
 * Юнит-тесты видят переменную в профиле и фразу в дописке; вопрос же в том, что
 * сделает с ними CLI. Подменена одна модель: стаб вместо API Anthropic, который
 * отвечает словом и называет контекст, какой ему велено. Всё остальное — своё:
 * окружение прогона строит настоящий `groupRunProfile`, дописку — настоящий
 * `childAppend`, вход идёт строками JSON в stdin, как у живой сессии панели.
 *
 * Случаи:
 * - окно группы из профиля (100k) при контексте 120k → CLI сжимает сам
 *   (`compact_boundary`, trigger auto), и в запросе сжатия — правило «что
 *   сохранить» из дописки группы;
 * - тот же разговор без окна → сжатия нет (проба видит то, что меряет);
 * - `/compact <что сохранить>` строкой JSON → текст доезжает до запроса сжатия.
 *
 * Каталог прогона — вне домашней папки: CLI собирает `.claude` всех родителей,
 * и личные навыки раздули бы постоянную часть так, что сжатие «не поможет».
 *
 * Запуск: `node tools/qa/check-group-compact.mjs`. Нужен установленный `claude`
 * (путь — `CLAUDE_CLI`); стенд и настройки человека не трогаются.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';

const PREFIX = 'cc-groupcompact-';
const KEEP = 'GCKEEP-7731 keep the stage ledger';
/** Контекст, который называет стаб, когда разговор уже большой. */
const BIG = 120_000;

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок ' : 'НЕТ'} ${text}`);
  if (!ok) bad += 1;
};

function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const root of [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')]) {
    if (existsSync(join(root, tail))) return join(root, tail);
  }
  return '';
}

/** Каталог без `.claude` у родителей: на Windows временная папка лежит в домашней. */
function workBase() {
  for (let dir = tmpdir(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.claude'))) break;
    if (dir === parse(dir).root) return tmpdir();
  }
  // PUBLIC есть только на Windows; на Linux с TMPDIR под домом — `/tmp`.
  const pub = process.platform === 'win32' ? process.env.PUBLIC : '/tmp';
  if (pub && existsSync(pub)) return pub;
  throw new Error('нет каталога вне домашней папки: задайте PUBLIC');
}

/** Стаб API: пишет каждый запрос; первый разговор мал, дальше контекст — BIG. */
function startStub() {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!req.url?.includes('/messages') || req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.url?.includes('count_tokens') ? '{"input_tokens":10}' : '{}');
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // пустое тело — тоже запрос
      }
      seen.push(body);
      const context = (body.messages ?? []).length > 1 ? BIG : 8_000;
      const events = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'msg_gc',
              type: 'message',
              role: 'assistant',
              model: 'stub',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 10, cache_read_input_tokens: context, output_tokens: 1 },
            },
          },
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const [event, data] of events)
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seen,
        close: () => server.close(),
      }),
    ),
  );
}

const lines = (out) =>
  out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {};
      }
    });
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const isCompaction = (body) =>
  JSON.stringify(body.messages ?? []).includes('Respond with TEXT ONLY');

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new Error('claude не найден: задайте CLAUDE_CLI');
  const { groupRunProfile } =
    await import('../../apps/server/src/domains/chat/group-profile/group-profile.ts');
  const { childAppend, initiativePrompt } =
    await import('../../apps/server/src/domains/chat/initiative/initiative.ts');
  const append = childAppend(
    initiativePrompt({ taskSplitInitiative: true, handoffInitiative: true }, { splitMuted: true }),
  );
  const stub = await startStub();
  const work = mkdtempSync(join(workBase(), PREFIX));
  console.log(`CLI: ${exe}\nКаталог: ${work}\n`);

  /** Один разговор: три хода, второй большой; окружение — от профиля группы. */
  async function conversation(label, profileInput, third) {
    const home = join(work, label, 'home');
    const project = join(work, label, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(home, 'settings.json'), '{}');
    const appendFile = join(work, label, 'append.txt');
    writeFileSync(appendFile, append, 'utf8');
    const profile = groupRunProfile({ entries: [], tasksText: '', extra: [], ...profileInput });
    const env = {
      ...process.env,
      ...profile.env,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_AUTH_TOKEN: 'gc-stub',
      ANTHROPIC_API_KEY: 'gc-stub',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      DISABLE_AUTOUPDATER: '1',
    };
    if (!profileInput.compactWindow) delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    const base = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--append-system-prompt-file',
      appendFile,
    ];
    const turn = (args, message) =>
      new Promise((resolve) => {
        const child = spawn(exe, args, { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (chunk) => (out += chunk));
        const timer = setTimeout(() => child.kill(), 120_000);
        child.on('close', () => {
          clearTimeout(timer);
          resolve(lines(out));
        });
        child.stdin.end(`${JSON.stringify(user(message))}\n`);
      });
    const first = await turn(base, 'start the group task');
    const session = first.find((event) => event.session_id)?.session_id;
    await turn(
      [...base, '--resume', session],
      `long tool output ${'lorem ipsum dolor '.repeat(24_000)}`,
    );
    const from = stub.seen.length;
    const events = await turn([...base, '--resume', session], third);
    return { events, requests: stub.seen.slice(from) };
  }

  const auto = await conversation('window', { compactWindow: 100_000 }, 'next step');
  const boundary = auto.events.find((event) => event.subtype === 'compact_boundary');
  check(
    boundary?.compact_metadata?.trigger === 'auto',
    `окно группы 100k при контексте 120k: автосжатие (${JSON.stringify(boundary?.compact_metadata?.trigger)})`,
  );
  const autoRequest = auto.requests.find(isCompaction);
  check(Boolean(autoRequest), 'запрос сжатия ушёл к модели');
  check(
    JSON.stringify(autoRequest?.system ?? '').includes('stage ledger'),
    'в запросе сжатия — правило «что сохранить» из дописки группы',
  );

  const plain = await conversation('no-window', {}, 'next step');
  check(
    !plain.events.some((event) => event.subtype === 'compact_boundary'),
    'без окна при том же контексте сжатия нет',
  );
  check(!plain.requests.some(isCompaction), 'без окна запроса сжатия нет');

  const manual = await conversation('manual', {}, `/compact ${KEEP}`);
  const manualBoundary = manual.events.find((event) => event.subtype === 'compact_boundary');
  check(
    manualBoundary?.compact_metadata?.trigger === 'manual',
    '/compact строкой JSON — ручное сжатие',
  );
  check(
    manual.requests.some((body) => isCompaction(body) && JSON.stringify(body).includes(KEEP)),
    'текст «что сохранить» из /compact доехал до запроса сжатия',
  );

  stub.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log(bad ? `\nПровалов: ${bad}` : '\nВсё ок');
  process.exit(bad ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
