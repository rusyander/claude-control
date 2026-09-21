import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_SHIM_MARKER,
  buildHookShimSource,
  hookShimCommand,
  hookShimConfig,
  hookShimFieldsOf,
  hookShimState,
  installHookShim,
  readHookShimCommand,
} from './hook-shim.ts';
import { SUPERVISOR_EVENTS, payloadFieldsOfEvent } from '../supervisor/payload.ts';

/**
 * Переходник проверяется ЗАПУСКОМ: настоящий `node` исполняет сгенерированный
 * файл, файл зовёт настоящий скрипт человека, и доказательством служит то, что
 * НАПИСАЛ САМ СКРИПТ. Таблица нагрузок, поданная функции напрямую, доказывала бы
 * таблицу — а вопрос здесь в том, что доедет до скрипта через stdin, оболочку и
 * код возврата.
 */

/**
 * Скрипт человека: панель его не писала, не правит и не копирует. Он сбрасывает
 * в файл ВСЁ, что увидел, — байты stdin, свой argv и разобранную нагрузку.
 */
const USER_SCRIPT = `import { writeFileSync } from 'node:fs';
import { stdin } from 'node:process';

let raw = '';
for await (const chunk of stdin) raw += chunk;

let payload = null;
try {
  payload = JSON.parse(raw);
} catch {
  payload = null;
}

writeFileSync(
  process.argv[2],
  JSON.stringify({
    raw,
    argv: process.argv.slice(1),
    keys: payload && typeof payload === 'object' ? Object.keys(payload) : null,
    payload,
  }),
  'utf8',
);

process.exit(Number(process.env.HOOK_EXIT ?? '0'));
`;

interface Seen {
  raw: string;
  argv: string[];
  keys: string[] | null;
  payload: Record<string, unknown> | null;
}

describe('переходник нагрузки для родных хуков', () => {
  let dir: string;
  let scriptPath: string;
  let seenPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hook-shim-'));
    scriptPath = join(dir, 'user-hook.mjs');
    seenPath = join(dir, 'seen.json');
    writeFileSync(scriptPath, USER_SCRIPT, 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const slash = (path: string) => path.split('\\').join('/');

  /** Команда человека: путь скрипта плюс аргумент — её переходник не разбирает. */
  const userCommand = () =>
    `"${slash(process.execPath)}" "${slash(scriptPath)}" "${slash(seenPath)}"`;

  const install = (event: string) => installHookShim({ dir, event, command: userCommand() });

  /** Прогон: нагрузка хозяина уходит переходнику на stdin, как это делает CLI. */
  const run = (
    event: string,
    hostPayload: unknown,
    options: { exit?: string; raw?: string } = {},
  ) => {
    const shim = install(event);
    const result = spawnSync(process.execPath, [shim.path], {
      input: options.raw ?? JSON.stringify(hostPayload),
      encoding: 'utf8',
      env: { ...process.env, HOOK_EXIT: options.exit ?? '0' },
    });
    return { shim, result };
  };

  const seen = (): Seen => JSON.parse(readFileSync(seenPath, 'utf8')) as Seen;

  it('нагрузка хозяина доезжает до скрипта именами Claude', () => {
    const { result } = run('UserPromptSubmit', {
      hookEventName: 'UserPromptSubmit',
      sessionId: 'sess-1',
      cwd: 'C:/work/demo',
      transcriptPath: 'C:/work/demo/chat.jsonl',
      userPrompt: 'почини сборку',
    });

    expect(result.status).toBe(0);
    // Доказательство — файл, который написал сам скрипт человека.
    expect(seen().payload).toEqual({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-1',
      cwd: 'C:/work/demo',
      transcript_path: 'C:/work/demo/chat.jsonl',
      prompt: 'почини сборку',
    });
  });

  it('поля, которого в нагрузке хозяина нет, скрипт не получает вовсе', () => {
    run('UserPromptSubmit', { sessionId: 'sess-1', cwd: 'C:/work/demo', prompt: 'привет' });

    const observed = seen();
    expect(observed.keys).not.toContain('transcript_path');
    // Именно отсутствие, а не пустая строка: скрипт обязан отличать «нет данных»
    // от «данные пустые», и на глаз в байтах stdin этого поля тоже нет.
    expect(observed.raw).not.toContain('transcript_path');
  });

  it('пустая строка и `false` — это данные, они доезжают', () => {
    run('UserPromptSubmit', { sessionId: 's', cwd: 'c', transcriptPath: 't', prompt: '' });
    expect(seen().payload).toMatchObject({ prompt: '' });

    run('Stop', { sessionId: 's', cwd: 'c', transcriptPath: 't', stopHookActive: false });
    expect(seen().payload).toMatchObject({ stop_hook_active: false });
  });

  it('поле, которого у события не бывает, переходник не пропускает', () => {
    // Таблица полей объявлена в `supervisor/payload.ts`: у `SessionStart` текста
    // человека нет, и хозяин, приславший его, не имеет права протолкнуть поле,
    // которого скрипт у Claude на этом событии не увидел бы.
    run('SessionStart', { sessionId: 's', cwd: 'c', transcriptPath: 't', prompt: 'лишнее' });
    expect(seen().keys).not.toContain('prompt');
  });

  it('текст с кавычками, косыми и переводом строки доезжает байт в байт', () => {
    const evil = 'путь C:\\Users\\«рустам»\necho "$PATH" && rm -rf / # \'конец\'';
    run('UserPromptSubmit', { sessionId: 's', cwd: 'c', transcriptPath: 't', prompt: evil });
    expect(seen().payload?.prompt).toBe(evil);
  });

  it('нагрузка уходит ТОЛЬКО через stdin, в argv её нет', () => {
    run('UserPromptSubmit', {
      sessionId: 'sess-1',
      cwd: 'c',
      transcriptPath: 't',
      prompt: 'секрет',
    });

    const observed = seen();
    expect(observed.raw).toContain('секрет');
    // На Windows цепочка cmd.exe → .cmd → .exe уничтожает текст с кавычками:
    // нагрузке в аргументах нельзя оказаться ни при каком случае.
    expect(observed.argv.join(' ')).not.toContain('секрет');
    expect(observed.argv.join(' ')).not.toContain('session_id');
  });

  it('код возврата скрипта уходит хозяину нетронутым', () => {
    const blocked = run(
      'UserPromptSubmit',
      { sessionId: 's', cwd: 'c', transcriptPath: 't', prompt: 'нельзя' },
      { exit: '2' },
    );
    expect(blocked.result.status).toBe(2);

    const passed = run('UserPromptSubmit', {
      sessionId: 's',
      cwd: 'c',
      transcriptPath: 't',
      prompt: 'можно',
    });
    expect(passed.result.status).toBe(0);
  });

  it('скрипт человека не правится и не копируется', () => {
    const before = readFileSync(scriptPath, 'utf8');
    const { shim } = run('UserPromptSubmit', { sessionId: 's', cwd: 'c', prompt: 'x' });

    expect(readFileSync(scriptPath, 'utf8')).toBe(before);
    // Рядом с переходником лежит только он сам, скрипт и файл-доказательство:
    // копии пользовательского скрипта не появилось.
    expect(readdirSync(dir).sort()).toEqual(
      [shim.path, scriptPath, seenPath].map((path) => path.split(/[\\/]/).pop()).sort(),
    );
  });

  it('у события вне таблицы канона чужие поля доезжают своими именами', () => {
    // Состав событий инструментов принадлежит П4: выбросить их поля значило бы
    // отнять у скрипта единственные данные события, а переименовать — выдумать
    // имена за канон.
    run('PreToolUse', {
      sessionId: 'sess-1',
      cwd: 'c',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(seen().payload).toEqual({
      session_id: 'sess-1',
      cwd: 'c',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
  });

  it('неразобранная нагрузка уходит скрипту как есть и об этом говорится', () => {
    const { result } = run('UserPromptSubmit', undefined, { raw: '{ не json' });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('разобрать не удалось');
    expect(seen().raw).toBe('{ не json');
  });

  it('переходник узнаётся маркером и второй раз не пишется', () => {
    const first = installHookShim({ dir, event: 'Stop', command: userCommand() });
    expect(first.written).toBe(true);
    expect(readFileSync(first.path, 'utf8')).toContain(HOOK_SHIM_MARKER);

    const second = installHookShim({ dir, event: 'Stop', command: userCommand() });
    expect(second.written).toBe(false);
    expect(second.state).toBe('ours');
  });

  it('правку человека не затирает, а называет', () => {
    const first = installHookShim({ dir, event: 'Stop', command: userCommand() });
    const edited = `${readFileSync(first.path, 'utf8')}\n// моя правка\n`;
    writeFileSync(first.path, edited, 'utf8');

    const again = installHookShim({ dir, event: 'Stop', command: userCommand() });
    expect(again.customized).toBe(true);
    expect(again.written).toBe(false);
    expect(readFileSync(again.path, 'utf8')).toBe(edited);

    // Переписать правленный файл — отдельное явное действие.
    const forced = installHookShim({ dir, event: 'Stop', command: userCommand(), force: true });
    expect(forced.written).toBe(true);
    expect(hookShimState(readFileSync(forced.path, 'utf8'))).toBe('ours');
  });

  it('файл, пересохранённый редактором в CRLF, остаётся своим', () => {
    // Иначе открытие в Блокноте навсегда заморозило бы переходник «правкой».
    const first = installHookShim({ dir, event: 'Stop', command: userCommand() });
    const crlf = readFileSync(first.path, 'utf8').split('\n').join('\r\n');
    writeFileSync(first.path, crlf, 'utf8');

    expect(hookShimState(crlf)).toBe('ours');
    expect(installHookShim({ dir, event: 'Stop', command: userCommand() }).customized).toBe(false);
  });
});

describe('поля переходника — объявлением канона, а не догадкой', () => {
  it('набор полей каждого события совпадает с таблицей нагрузки', () => {
    for (const event of SUPERVISOR_EVENTS) {
      expect(hookShimFieldsOf(event).map((field) => field.name)).toEqual([
        ...payloadFieldsOfEvent(event),
      ]);
    }
  });

  it('у каждого поля есть и camelCase-написание', () => {
    const fields = hookShimFieldsOf('PreCompact');
    const instructions = fields.find((field) => field.name === 'custom_instructions');
    expect(instructions?.from).toContain('customInstructions');
  });

  it('событие вне таблицы канона получает общие поля и пропуск остального', () => {
    // Имя выдуманное намеренно: подставить сюда настоящее событие значит
    // однажды проверять им обратное — так и случилось, когда `PostToolUse`
    // стоял здесь примером «вне таблицы», а провод П4 внёс его в таблицу.
    const config = hookShimConfig({ event: 'SomeFutureEvent', command: 'x' });
    expect(config.passthrough).toBe(true);
    expect(config.fields.map((field) => field.name)).toEqual([
      'hook_event_name',
      'session_id',
      'cwd',
      'transcript_path',
    ]);
  });

  it('события инструментов в таблице ЕСТЬ, и переходник несёт их поля', () => {
    // Иначе перенесённый хук вызова получил бы общие четыре поля и судил бы о
    // вызове, не зная ни имени инструмента, ни аргументов.
    const pre = hookShimConfig({ event: 'PreToolUse', command: 'x' });
    expect(pre.passthrough).toBe(false);
    expect(pre.fields.map((field) => field.name)).toContain('tool_name');
    expect(pre.fields.map((field) => field.name)).toContain('tool_input');

    const post = hookShimConfig({ event: 'PostToolUse', command: 'x' });
    expect(post.fields.map((field) => field.name)).toContain('tool_response');
  });

  it('в тексте переходника нет ни импорта панели, ни её путей', () => {
    // Скрипт переживает остановку панели и переезд её папки: ссылка внутрь неё
    // сломала бы хук у человека, который про панель уже забыл.
    const source = buildHookShimSource(hookShimConfig({ event: 'Stop', command: 'node hook.mjs' }));
    expect(source).not.toMatch(/from '\.\.?\//);
    expect(source).not.toContain('domains/portability');
  });
});

describe('обратное чтение: команда человека из-под переходника', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hook-shim-unwrap-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('команда переходника разворачивается в команду человека', () => {
    // Без этого повторный импорт записал бы в канон сгенерированный посредник
    // вместо скрипта человека: перенос подменил бы людям их же хуки.
    const command = 'node "C:/work/my-hook.mjs"';
    const installed = installHookShim({ dir, event: 'UserPromptSubmit', command });

    expect(readHookShimCommand(hookShimCommand(installed.path))).toBe(command);
  });

  it('обычная команда остаётся человеческой', () => {
    expect(readHookShimCommand('node "C:/work/my-hook.mjs"')).toBeUndefined();
    expect(readHookShimCommand('./gate.sh --strict')).toBeUndefined();
  });

  it('файл без метки переходником не считается', () => {
    const path = join(dir, 'looks-like-shim.mjs');
    writeFileSync(path, 'const CONFIG = {\n  "command": "node evil.mjs"\n};\n', 'utf8');

    expect(readHookShimCommand(hookShimCommand(path))).toBeUndefined();
  });
});
