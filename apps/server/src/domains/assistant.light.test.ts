import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClaudeLocation } from '@agentdeck/contracts';
import { SECRET_MASK } from '../lib/secret-mask.ts';
import { askAssistant, type AssistRequest } from './assistant.ts';
import { assistStructure } from './resources/ResourceAssistant.ts';

/**
 * Помощник формы — лёгкое окно (решение владельца D4, 28.09): без инструментов,
 * без сохранения сессии, без наших слоёв (правила, хуки, скиллы, MCP человека),
 * история — в самом запросе, секреты формы — маской до модели.
 *
 * До правки помощник запускал `claude -p` со всеми слоями человека и
 * инструментами, в каталоге сервера, и продолжал разговор через `--resume`:
 * в `~/.claude/projects/…apps-server/` копились транскрипты с правилами,
 * хуками и значениями полей формы — включая секреты MCP-сервера.
 *
 * Здесь запуск настоящий: фальшивый `claude` пишет свой argv, рабочий каталог и
 * stdin и отвечает заданным текстом.
 */
const isWindows = process.platform === 'win32';

const FAKE = `
import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const near = (name) => new URL('./' + name, import.meta.url);
writeFileSync(near('dump.json'), JSON.stringify({ argv, cwd: process.cwd(), stdin: Buffer.concat(chunks).toString('utf8') }));
const answer = readFileSync(near('answer.json'), 'utf8');
process.stdout.write(JSON.stringify({ result: answer, session_id: 'sess-light' }));
`;

const SECRET_ENV = 'qa-secret-7f3k2';
const SECRET_HEADER = 'qa-hdr-9x8y7';
const PASSWORD = 'hunter2';
const TYPED_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const HISTORY_PASSWORD = 'hunter3x';

interface Dump {
  argv: string[];
  cwd: string;
  stdin: string;
}

let dir: string;
let command: string;

function answer(value: unknown): void {
  writeFileSync(join(dir, 'answer.json'), JSON.stringify(value), 'utf8');
}

function dump(): Dump {
  return JSON.parse(readFileSync(join(dir, 'dump.json'), 'utf8')) as Dump;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
}

/** Лёгкое окно по argv: те же флаги, что у агента панели. */
function expectLightWindow(seen: Dump): void {
  expect(seen.argv).toContain('--no-session-persistence');
  expect(seen.argv).toContain('--strict-mcp-config');
  expect(seen.argv).toContain('--disable-slash-commands');
  expect(flagValue(seen.argv, '--setting-sources')).toBe('local');
  expect(seen.argv).toContain('--tools');
  expect(flagValue(seen.argv, '--tools')).toBe('');
  expect(seen.argv).not.toContain('--resume');
  // Рабочий каталог — пустая временная папка, а не каталог сервера: CLI ищет
  // CLAUDE.md вверх от него, и каталог сервера принёс бы правила репозитория.
  const cwd = seen.cwd.toLowerCase();
  expect(cwd).not.toBe(process.cwd().toLowerCase());
  expect(cwd.startsWith(tmpdir().toLowerCase())).toBe(true);
  expect(cwd).toContain('cc-assistant-');
  // И убрана за собой.
  expect(existsSync(seen.cwd)).toBe(false);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-assist-light-'));
  const script = join(dir, 'fake-claude.mjs');
  writeFileSync(script, FAKE, 'utf8');
  if (isWindows) {
    command = join(dir, 'claude.cmd');
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    command = join(dir, 'claude');
    writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
      mode: 0o755,
    });
  }
  answer({ reply: 'ok', fields: {} });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base: AssistRequest = {
  kind: 'rule',
  message: 'заполни',
  fields: {},
  schema: { title: 'Rule title. Value: a string.' },
};

describe('askAssistant: лёгкое окно', () => {
  it('без инструментов, без сессии и наших слоёв, во временном каталоге; прежний sessionId не продолжается', async () => {
    const response = await askAssistant(
      { ...base, sessionId: 'd3b07384-d9a0-4c9b-8a4e-0f1e2d3c4b5a' } as AssistRequest,
      command,
    );
    expect(response.error).toBeUndefined();
    expectLightWindow(dump());
    // Ответ больше не несёт сессию: продолжать нечего, история едет в теле.
    expect(response).not.toHaveProperty('sessionId');
  });

  it('история разговора едет в теле запроса, по порядку, перед текущей просьбой', async () => {
    await askAssistant(
      {
        ...base,
        message: 'теперь поменяй только описание',
        history: [
          { role: 'user', text: 'назови правило lint-on-save' },
          { role: 'assistant', text: 'Назвал: lint-on-save' },
        ],
      },
      command,
    );
    const { stdin } = dump();
    const first = stdin.indexOf('Human: назови правило lint-on-save');
    const second = stdin.indexOf('Assistant: Назвал: lint-on-save');
    const current = stdin.indexOf("The user's current request: теперь поменяй только описание");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(current).toBeGreaterThan(second);
  });

  it('задание учит виду значений и режиму «только предложить»', async () => {
    await askAssistant(base, command);
    const { stdin } = dump();
    // Пример ответа показывает не только строку: список и число.
    expect(stdin).toMatch(/"matchers": \["Edit", "Write"\]/);
    expect(stdin).toMatch(/"timeout": 30/);
    // Вид значения — по строке Value: поля.
    expect(stdin).toMatch(/follows its field's "Value:" line/);
    expect(stdin).toMatch(/never a comma-separated string/);
    // Только предложить — пустые поля, предложения в reply.
    expect(stdin).toMatch(/only for suggestions[^]*"fields": \{\}/);
  });

  it('секреты полей формы, просьбы и истории до модели не доходят — только маска', async () => {
    await askAssistant(
      {
        ...base,
        kind: 'MCP server',
        message: `поставь токен ${TYPED_TOKEN}`,
        history: [{ role: 'user', text: `база postgres://qa:${HISTORY_PASSWORD}@db/main` }],
        fields: {
          name: 'qa-srv',
          envText: `QA_API_TOKEN=${SECRET_ENV}\nQA_MODE=1`,
          headersText: `Authorization=Bearer ${SECRET_HEADER}`,
          key: 'QA_DB_PASSWORD',
          value: PASSWORD,
        },
      },
      command,
    );
    const { stdin } = dump();
    for (const secret of [SECRET_ENV, SECRET_HEADER, PASSWORD, TYPED_TOKEN, HISTORY_PASSWORD]) {
      expect(stdin).not.toContain(secret);
    }
    expect(stdin).toContain(SECRET_MASK);
    // Не секреты остаются видны: модель должна понимать форму.
    expect(stdin).toContain('QA_MODE=1');
    expect(stdin).toContain('QA_DB_PASSWORD');
    expect(stdin).toContain('qa-srv');
  });

  it('маска в ответе возвращается секретом формы; не сошлась — поле не трогается и названо', async () => {
    answer({
      reply: 'Добавил QA_NEW.',
      fields: {
        envText: `QA_API_TOKEN=${SECRET_MASK}\nQA_MODE=1\nQA_NEW=2`,
        value: SECRET_MASK,
        // Лишняя маска: вернуть нечего — запись маски стёрла бы секрет.
        headersText: `Authorization=${SECRET_MASK} ${SECRET_MASK}\nX-Extra=${SECRET_MASK}`,
        comment: 'ok',
      },
    });
    const response = await askAssistant(
      {
        ...base,
        kind: 'MCP server',
        fields: {
          envText: `QA_API_TOKEN=${SECRET_ENV}\nQA_MODE=1`,
          headersText: `Authorization=Bearer ${SECRET_HEADER}`,
          key: 'QA_DB_PASSWORD',
          value: PASSWORD,
        },
      },
      command,
    );
    expect(response.fields).toEqual({
      envText: `QA_API_TOKEN=${SECRET_ENV}\nQA_MODE=1\nQA_NEW=2`,
      value: PASSWORD,
      comment: 'ok',
    });
    expect(response.kept).toEqual(['headersText']);
  });
});

describe('assistStructure: то же лёгкое окно', () => {
  it('без инструментов и сессии, история — в теле', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-assist-struct-'));
    try {
      const location = {
        source: 'manual',
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          appData: join(root, 'agentdeck'),
        },
        isValid: true,
        missing: [],
      } as unknown as ClaudeLocation;
      answer({ reply: 'Собрал.', files: [{ path: 'SKILL.md', content: '# demo' }] });
      const result = await assistStructure(
        'skill',
        'demo',
        'добавь раздел примеров',
        location,
        command,
        [
          { role: 'user', text: 'собери скилл demo' },
          { role: 'assistant', text: 'Собрал SKILL.md' },
        ],
      );
      expect(result.error).toBeUndefined();
      expect(result.files).toEqual([{ path: 'SKILL.md', content: '# demo' }]);
      const seen = dump();
      expectLightWindow(seen);
      expect(seen.stdin.indexOf('Human: собери скилл demo')).toBeGreaterThan(-1);
      expect(seen.stdin.indexOf('Assistant: Собрал SKILL.md')).toBeGreaterThan(
        seen.stdin.indexOf('Human: собери скилл demo'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
