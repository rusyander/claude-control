import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProviderCli } from '../../domains/assistant-runner/cli.ts';
import type { RunAssistantDeps } from '../../domains/assistant-runner/assistant-runner.ts';
import { ProviderChatRun } from '../../domains/provider-chat/ProviderChatRun/ProviderChatRun.ts';
import { getProvider } from '../registry.ts';
import {
  aiderOneShotArgs,
  aiderOneShotEnv,
  createAiderStdoutParser,
  insideGitTree,
} from './aider-run.ts';

/**
 * Одиночный запуск Aider. Фикстуры — НАСТОЯЩИЙ stdout aider-chat 0.86.2, снятый
 * живым прогоном с этими самыми argv и окружением на заглушке модели (путь к
 * временному репозиторию заменён на `..\work\.git`, переводы строки — LF; форма
 * Windows с CRLF проверяется тут же преобразованием).
 */
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '__fixtures__', `aider-0.86.2-${name}.txt`), 'utf8');

const parseWhole = (text: string): string => {
  const parser = createAiderStdoutParser();
  return `${parser.push(text)}${parser.end()}`;
};

/** Поток по одному символу — худший случай границ чтения. */
const parseByChar = (text: string): string => {
  const parser = createAiderStdoutParser();
  let out = '';
  for (const char of text) out += parser.push(char);
  return out + parser.end();
};

const crlf = (text: string): string => text.replace(/\n/g, '\r\n');

describe('aider: argv одиночного запуска', () => {
  const yes = () => true;
  const no = () => false;

  it('промпт — отдельным элементом сразу после --message, без склейки', () => {
    const prompt = 'почини баг; rm -rf / && echo "PWNED"';
    const args = aiderOneShotArgs(prompt, undefined, no);
    expect(args.slice(0, 2)).toEqual(['--message', prompt]);
    expect(args.filter((arg) => arg.includes(prompt))).toEqual([prompt]);
  });

  it('«Разрешить правки» → --yes-always; выключено или не задано → --dry-run', () => {
    const on = aiderOneShotArgs('P', { allowEdits: true }, no);
    const off = aiderOneShotArgs('P', { allowEdits: false }, no);
    const unset = aiderOneShotArgs('P', {}, no);
    expect(on).toContain('--yes-always');
    expect(on).not.toContain('--dry-run');
    expect(off).toContain('--dry-run');
    expect(off).not.toContain('--yes-always');
    expect(unset).toEqual(off);
    expect(aiderOneShotArgs('P', undefined, no)).toEqual(off);
  });

  it.each([true, false])(
    'коммитов, .gitignore и команд оболочки нет ни в каком режиме (allowEdits=%s)',
    (allowEdits) => {
      const args = aiderOneShotArgs('P', { allowEdits }, yes);
      for (const flag of [
        '--no-auto-commits',
        '--no-dirty-commits',
        '--no-gitignore',
        '--no-suggest-shell-commands',
        '--no-check-update',
        '--no-show-release-notes',
        '--no-show-model-warnings',
        '--no-analytics',
        '--no-detect-urls',
        '--no-pretty',
        '--no-fancy-input',
      ]) {
        expect(args).toContain(flag);
      }
      expect(args).toContain('--chat-history-file');
      expect(args).toContain('--input-history-file');
    },
  );

  it('git: каталог в репозитории — с git; вне репозитория или без каталога — --no-git', () => {
    expect(aiderOneShotArgs('P', { workdir: '/repo' }, yes)).not.toContain('--no-git');
    expect(aiderOneShotArgs('P', { workdir: '/plain' }, no)).toContain('--no-git');
    expect(aiderOneShotArgs('P', { allowEdits: true }, yes)).toContain('--no-git');
  });

  it('окружение: stdout Python в UTF-8 и без переноса строк rich', () => {
    expect(aiderOneShotEnv()).toEqual({
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      COLUMNS: '4000',
    });
  });
});

describe('aider: insideGitTree', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('находит .git выше по дереву и не находит без него', () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aider-git-')));
    const plain = join(root, 'plain', 'deep');
    const repo = join(root, 'repo');
    mkdirSync(plain, { recursive: true });
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src', 'lib'), { recursive: true });
    expect(insideGitTree(join(repo, 'src', 'lib'))).toBe(true);
    expect(insideGitTree(repo)).toBe(true);
    // Временный каталог ОС не лежит внутри репозитория на машине разработки и в CI.
    expect(insideGitTree(plain)).toBe(false);
  });
});

describe('aider: разбор stdout (живые фикстуры 0.86.2)', () => {
  const cases: [string, string][] = [
    // Вопрос о файле без человека; ответ модели — той же строкой после «[Yes]: ».
    ['git-dry-mention', 'Привет! Ответ заглушки: «ёлка» — 42.\n\nВторая строка ответа.\n'],
    // --yes-always: вопрос не печатается, только имя файла перед ответом.
    [
      'git-yes-edit',
      'Here is the change.\n\nnote.txt\n```\nCHANGED BY STUB\n```\n\nApplied edit to note.txt\n',
    ],
    // --no-git + --dry-run: вопрос о правке после расхода, исход — «не применено».
    [
      'nogit-dry-edit',
      'Here is the change.\n\nnote.txt\n```\nCHANGED BY STUB\n```\n\nDid not apply edit to note.txt (--dry-run)\n',
    ],
    // Три повторные попытки Aider: исход показан один раз, служебное отрезано.
    [
      'git-dry-shell',
      'Run this:\n\n```bash\necho shell-ran > ran.txt\n```\n\nThe LLM did not conform to the edit format.\n',
    ],
  ];

  it.each(cases)('%s: ответ без заставки, вопросов и расхода токенов', (name, expected) => {
    const raw = fixture(name);
    expect(parseWhole(raw)).toBe(expected);
    expect(parseWhole(crlf(raw))).toBe(expected);
    expect(parseByChar(crlf(raw))).toBe(expected);
    const reply = parseWhole(crlf(raw));
    for (const chrome of [
      'Aider v',
      'Model:',
      'Git repo:',
      'Repo-map:',
      'Tokens:',
      '(Y)es',
      '\r',
    ]) {
      expect(reply).not.toContain(chrome);
    }
  });

  it('поток: ответ идёт кусками до конца строки, «Tokens:» не просачивается даже рваным', () => {
    const parser = createAiderStdoutParser();
    expect(
      parser.push('Aider v0.86.2\r\nModel: m\r\nGit repo: none\r\nRepo-map: disabled\r\n'),
    ).toBe('');
    expect(parser.push('\r\nПри')).toBe('При');
    expect(parser.push('вет\r\nTok')).toBe('вет\n');
    expect(parser.push('ens: 5 sent, 1 received.\r\n')).toBe('');
    expect(parser.end()).toBe('');
  });

  it('незнакомая форма (нет строки Repo-map) — вывод целиком, а не пустой ответ', () => {
    const text = 'litellm.AuthenticationError: bad key\r\n';
    expect(parseWhole(text)).toBe('litellm.AuthenticationError: bad key\n');
  });
});

describe('aider: каталог и путь ассистента', () => {
  it('ключ только OpenAI и только в OpenAI; правки флагом; свой разбор stdout', () => {
    const assistant = getProvider('aider').assistant;
    expect(assistant?.apiKind).toBe('openai');
    expect(assistant?.apiKeyEnvVars).toEqual(['OPENAI_API_KEY']);
    expect(assistant?.apiBaseUrl).toBeUndefined();
    expect(assistant?.editsControl).toBe('flag');
    expect(assistant?.parseStdout).toBe(createAiderStdoutParser);
    expect(assistant?.oneShotEnv?.()).toEqual(aiderOneShotEnv());
  });

  it('ассистент формы: каталог запуска → --no-git, окружение UTF-8 и разбор stdout дошли до CLI', async () => {
    const workdir = realpathSync.native(mkdtempSync(join(tmpdir(), 'aider-assist-')));
    const calls: { args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }[] = [];
    const spawnImpl = ((
      _cmd: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv; cwd?: string },
    ) => {
      calls.push({ args, env: options.env, cwd: options.cwd });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { write: () => void; end: () => void; on: () => void };
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, end: () => {}, on: () => {} };
      child.kill = () => child.emit('close', null);
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(crlf(fixture('git-dry-mention'))));
        child.emit('close', 0);
      }, 0);
      return child;
    }) as unknown as RunAssistantDeps['spawnImpl'];
    try {
      const result = await runProviderCli(
        getProvider('aider'),
        'Скажи привет',
        { appDataDir: workdir, spawnImpl },
        process.execPath,
        workdir,
      );
      expect(result.ok).toBe(true);
      expect(result.reply).toBe('Привет! Ответ заглушки: «ёлка» — 42.\n\nВторая строка ответа.');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.cwd).toBe(workdir);
      expect(calls[0]?.args).toContain('--no-git');
      expect(calls[0]?.args).toContain('--dry-run');
      expect(calls[0]?.env?.PYTHONUTF8).toBe('1');
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe('aider: чат панели (ProviderChatRun) доносит каталог, правки, окружение и разбор', () => {
  type SpawnImpl = Parameters<ProviderChatRun['start']>[0]['spawnImpl'];
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  const runIn = async (workdir: string, allowEdits: boolean) => {
    const calls: { line: string; env?: NodeJS.ProcessEnv }[] = [];
    const spawnImpl = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ line: [command, ...args].join(' '), env: options.env });
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, end: () => {}, on: () => {} };
      child.kill = () => child.emit('close', null);
      setTimeout(() => {
        (child.stdout as EventEmitter).emit('data', Buffer.from(crlf(fixture('git-dry-mention'))));
        child.emit('close', 0);
      }, 0);
      return child;
    }) as unknown as SpawnImpl;
    const events: { type: string; reply?: string }[] = [];
    await new ProviderChatRun().start(
      {
        provider: getProvider('aider'),
        history: [{ id: 'm1', role: 'user', content: 'Вопрос', at: '2026-01-01T00:00:00.000Z' }],
        chatId: 'chat',
        appDataDir: root,
        detect: () => true,
        spawnImpl,
        workdir,
        permission: { allowEdits },
      },
      (event) => events.push(event as { type: string; reply?: string }),
    );
    return { call: calls[0], done: events.find((event) => event.type === 'done') };
  };

  it('каталог-репозиторий: git включён; без репозитория: --no-git; ответ разобран', async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aider-pchat-')));
    const repo = join(root, 'repo');
    const plain = join(root, 'plain');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(plain, { recursive: true });

    const inRepo = await runIn(repo, true);
    expect(inRepo.call?.line).toContain('--yes-always');
    // Подстрока «--no-git» есть и в «--no-gitignore» — ищем флаг целиком.
    expect(inRepo.call?.line).not.toMatch(/--no-git(?![\w-])/);
    expect(inRepo.call?.env?.PYTHONUTF8).toBe('1');
    expect(inRepo.done?.reply).toBe(
      'Привет! Ответ заглушки: «ёлка» — 42.\n\nВторая строка ответа.',
    );

    const outside = await runIn(plain, false);
    expect(outside.call?.line).toContain('--dry-run');
    expect(outside.call?.line).toMatch(/--no-git(?![\w-])/);
  });
});
