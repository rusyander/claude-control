/**
 * Живое доказательство 3.1 плана экономии: потолок таймаута Bash группы на настоящем `claude`.
 *
 * Потолок задаёт переменная CLI `BASH_MAX_TIMEOUT_MS`; модель видит его в описании
 * инструмента Bash («up to N ms»), и только до него она может поднять таймаут гейта.
 * Окружение процесса проигрывает той же переменной в settings.json человека, поэтому
 * профиль группы кладёт её в файл `--settings` (ревью B-F02). Подменена одна модель:
 * стаб вместо API Anthropic пишет тела запросов; настройки флага строит настоящий
 * `groupRunProfile`.
 *
 * Случаи (в личном settings.json одноразового каталога конфигурации):
 * - человек задал 10 мин → у группы 30 мин (настройки флага главнее личных);
 * - человек задал 60 мин → у группы 60 мин (профиль потолок не занижает);
 * - контроль: тот же человек с 10 мин без профиля → 10 мин (проба видит то, что меряет).
 *
 * Каталог прогона — вне домашней папки: CLI собирает `.claude` всех родителей.
 * Запуск: `node tools/qa/check-group-bash-ceiling.mjs`. Нужен установленный `claude`
 * (путь — `CLAUDE_CLI`); стенд и настройки человека не трогаются.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';

const PREFIX = 'cc-bashceiling-';

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

/** Стаб API: пишет каждый запрос, отвечает словом. */
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
      try {
        seen.push(JSON.parse(raw));
      } catch {
        seen.push({});
      }
      const message = {
        id: 'msg_bc',
        type: 'message',
        role: 'assistant',
        model: 'stub',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      };
      const events = [
        ['message_start', { type: 'message_start', message }],
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

/** Потолок из описания Bash в запросе: «up to N ms» → N. */
function ceilingOf(body) {
  const bash = (body?.tools ?? []).find((tool) => tool.name === 'Bash');
  const match = /up to (\d+)\s*ms/i.exec(bash?.description ?? '');
  return match ? Number(match[1]) : null;
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new Error('claude не найден: задайте CLAUDE_CLI');
  const { groupRunProfile } =
    await import('../../apps/server/src/domains/chat/group-profile/group-profile.ts');
  const stub = await startStub();
  const work = mkdtempSync(join(workBase(), PREFIX));
  console.log(`CLI: ${exe}\nКаталог: ${work}\n`);

  /** Один ход: личный потолок `userMs`; `profile` — с настройками флага группы. */
  async function turn(label, userMs, profile) {
    const home = join(work, label, 'home');
    const project = join(work, label, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: String(userMs) } }),
    );
    const args = ['-p', '--output-format', 'json'];
    if (profile) {
      const run = groupRunProfile({
        entries: [],
        tasksText: '',
        extra: [],
        bashCeilings: [String(userMs)],
      });
      const settingsFile = join(work, label, 'flag-settings.json');
      writeFileSync(settingsFile, JSON.stringify(run.settings));
      args.push('--settings', settingsFile);
    }
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_AUTH_TOKEN: 'bc-stub',
      ANTHROPIC_API_KEY: 'bc-stub',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      DISABLE_AUTOUPDATER: '1',
    };
    delete env.BASH_MAX_TIMEOUT_MS;
    const from = stub.seen.length;
    await new Promise((resolve) => {
      const child = spawn(exe, [...args, 'hi'], { cwd: project, env, stdio: 'ignore' });
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const body = stub.seen.slice(from).find((item) => ceilingOf(item) !== null);
    return ceilingOf(body);
  }

  const raised = await turn('raise', 600_000, true);
  check(raised === 1_800_000, `человек задал 10 мин — у группы 30 мин (в описании Bash ${raised})`);
  const kept = await turn('keep', 3_600_000, true);
  check(kept === 3_600_000, `человек задал 60 мин — профиль не занизил (${kept})`);
  const control = await turn('control', 600_000, false);
  check(control === 600_000, `контроль без профиля — личные 10 мин (${control})`);

  stub.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log(bad ? `\nПровалов: ${bad}` : '\nВсё ок');
  process.exit(bad ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
