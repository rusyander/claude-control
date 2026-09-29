import { describe, it, expect } from 'vitest';
import { buildProgress } from './ChatProgress.ts';
import type { TranscriptRecord } from './ChatHistory.ts';

/**
 * Фон и текущий вызов в прогрессе. Тексты расписок и уведомлений — дословно те,
 * что CLI записал в живой разговор 23.09.2026, где обе фоновые команды умерли с
 * концом хода, а человек двадцать минут не знал, идёт ли работа.
 */

const at = (minute: number) => `2026-09-23T07:${String(minute).padStart(2, '0')}:00.000Z`;

function assistant(minute: number, blocks: unknown[]): TranscriptRecord {
  return {
    type: 'assistant',
    timestamp: at(minute),
    message: { content: blocks },
  } as TranscriptRecord;
}

function user(minute: number, content: unknown): TranscriptRecord {
  return { type: 'user', timestamp: at(minute), message: { content } } as TranscriptRecord;
}

const bash = (id: string, command: string, extra: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  name: 'Bash',
  id,
  input: { command, description: 'Install deps', ...extra },
});

const result = (id: string, text: string) => ({
  type: 'tool_result',
  tool_use_id: id,
  content: text,
});

const notification = (task: string, status: string) =>
  `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>x</tool-use-id>\n<status>${status}</status>\n<summary>Background shell command didn't finish before the previous session ended</summary>\n</task-notification>`;

describe('buildProgress — фон и текущий вызов', () => {
  it('команда, уведённая в фон по таймауту, видна фоновой, хотя фон не просили', () => {
    const progress = buildProgress([
      assistant(15, [bash('u1', 'node scripts/frontend_install.mjs 2>&1 | tail -8')]),
      user(25, [
        result(
          'u1',
          'Command did not complete within its 600s timeout and was moved to the background (ID: bxkhy3tpp). Output is being written to: C:\\tmp\\x.output',
        ),
      ]),
    ]);

    expect(progress.shells).toEqual([
      {
        id: 'u1',
        command: 'node scripts/frontend_install.mjs 2>&1 | tail -8',
        startedAt: at(15),
        status: 'running',
      },
    ]);
  });

  it('run_in_background закрывается уведомлением: stopped — оборвана концом процесса', () => {
    const progress = buildProgress([
      assistant(39, [
        bash('u2', 'node scripts/check_frontend.mjs --all', { run_in_background: true }),
      ]),
      user(39, [
        result(
          'u2',
          'Command running in background with ID: b0moxbbvx. Output is being written to: x',
        ),
      ]),
      user(52, notification('b0moxbbvx', 'stopped')),
    ]);

    expect(progress.shells?.map((shell) => shell.status)).toEqual(['stopped']);
  });

  it('completed — готово, failed — упала', () => {
    const progress = buildProgress([
      assistant(1, [bash('a', 'pnpm test', { run_in_background: true })]),
      user(1, [result('a', 'Command running in background with ID: t1.')]),
      assistant(2, [bash('b', 'pnpm lint', { run_in_background: true })]),
      user(2, [result('b', 'Command running in background with ID: t2.')]),
      user(3, [{ type: 'text', text: notification('t1', 'completed') }]),
      user(4, notification('t2', 'failed')),
    ]);

    expect(progress.shells?.map((shell) => [shell.id, shell.status])).toEqual([
      ['a', 'done'],
      ['b', 'failed'],
    ]);
  });

  it('уведомление, процитированное агентом, статус не меняет', () => {
    const progress = buildProgress([
      assistant(1, [bash('a', 'pnpm test', { run_in_background: true })]),
      user(1, [result('a', 'Command running in background with ID: t1.')]),
      assistant(2, [{ type: 'text', text: notification('t1', 'completed') }]),
    ]);

    expect(progress.shells?.[0]?.status).toBe('running');
  });

  it('вызов без результата — текущий, с описанием и временем старта', () => {
    const progress = buildProgress([
      assistant(1, [bash('a', 'pnpm install')]),
      user(2, [result('a', 'ok')]),
      assistant(3, [bash('b', 'pnpm test', { description: 'Wait for tests' })]),
    ]);

    expect(progress.activeTool).toEqual({
      name: 'Bash',
      summary: 'Wait for tests',
      startedAt: at(3),
    });
    expect(progress.shells).toBeUndefined();
  });

  /**
   * Живой прогон 29.09 (widget-app): агент поднял vite в фоне, а в конце хода
   * сам погасил его по порту — CLI об этом не знает, и панель писала «Фон
   * оборван» или «В фоне» с застывшим таймером. Команда — дословно из того хода.
   */
  it('агент погасил фоновый сервер командой по его порту — killed, не идёт и не оборван', () => {
    const progress = buildProgress([
      assistant(1, [
        bash('v', 'cd apps/host && npx vite --port 9123 --strictPort > /tmp/v.log 2>&1', {
          run_in_background: true,
        }),
      ]),
      user(1, [result('v', 'Command running in background with ID: bvite.')]),
      assistant(9, [
        bash(
          'k',
          'for p in $(netstat -ano | grep ":9123 " | grep LISTENING | awk \'{print $5}\'); do taskkill //PID $p //T //F; done',
        ),
      ]),
      user(9, [result('k', 'SUCCESS')]),
    ]);

    expect(progress.shells?.map((shell) => shell.status)).toEqual(['killed']);
  });

  it('kill по другому порту чужой сервер не трогает', () => {
    const progress = buildProgress([
      assistant(1, [bash('v', 'npx vite --port 9123', { run_in_background: true })]),
      user(1, [result('v', 'Command running in background with ID: bvite.')]),
      assistant(2, [bash('k', 'kill $(lsof -ti:5173)')]),
    ]);

    expect(progress.shells?.[0]?.status).toBe('running');
  });

  it('TaskStop агента по id задачи — killed', () => {
    const progress = buildProgress([
      assistant(1, [bash('a', 'pnpm dev', { run_in_background: true })]),
      user(1, [result('a', 'Command running in background with ID: t9.')]),
      assistant(2, [{ type: 'tool_use', name: 'TaskStop', id: 's', input: { task_id: 't9' } }]),
    ]);

    expect(progress.shells?.[0]?.status).toBe('killed');
  });

  // Ревью 29.09 (A7): CLI сам пишет итог погашенной задачи, и он не должен
  // снова делать уборку агента «обрывом».
  it('уведомление CLI после TaskStop — killed остаётся killed', () => {
    const progress = buildProgress([
      assistant(1, [bash('a', 'pnpm dev', { run_in_background: true })]),
      user(1, [result('a', 'Command running in background with ID: t9.')]),
      assistant(2, [{ type: 'tool_use', name: 'TaskStop', id: 's', input: { task_id: 't9' } }]),
      user(2, notification('t9', 'killed')),
    ]);

    expect(progress.shells?.[0]?.status).toBe('killed');
  });

  it('уведомление CLI «killed» само по себе — killed, не «оборвана»', () => {
    const progress = buildProgress([
      assistant(1, [bash('a', 'pnpm dev', { run_in_background: true })]),
      user(1, [result('a', 'Command running in background with ID: t9.')]),
      user(2, notification('t9', 'killed')),
    ]);

    expect(progress.shells?.[0]?.status).toBe('killed');
  });

  it('погашен по порту, потом пришёл итог failed — остаётся killed', () => {
    const progress = buildProgress([
      assistant(1, [bash('v', 'npx vite --port 9123', { run_in_background: true })]),
      user(1, [result('v', 'Command running in background with ID: bvite.')]),
      assistant(2, [bash('k', 'kill $(lsof -ti:9123)')]),
      user(2, [result('k', '')]),
      user(3, notification('bvite', 'failed')),
    ]);

    expect(progress.shells?.[0]?.status).toBe('killed');
  });

  // Ревью 29.09 (A9): слово kill в тексте и порт рядом — ещё не погашение.
  describe('погашение по порту — только настоящей командой', () => {
    const vite = [
      assistant(1, [bash('v', 'npx vite --port 9123', { run_in_background: true })]),
      user(1, [result('v', 'Command running in background with ID: bvite.')]),
    ];
    const statusAfter = (command: string, answer: unknown = [result('k', '')]) =>
      buildProgress([...vite, assistant(2, [bash('k', command)]), user(2, answer)]).shells?.[0]
        ?.status;

    it.each([
      ['kill в строке echo', 'curl localhost:9123 && echo "do not kill it"'],
      ['kill в шаблоне grep', 'grep "kill" src; curl localhost:9123'],
    ])('%s — сервер идёт', (_name, command) => {
      expect(statusAfter(command)).toBe('running');
    });

    it('погашение упало — сервер идёт', () => {
      expect(
        statusAfter('kill $(lsof -ti:9123)', [
          { type: 'tool_result', tool_use_id: 'k', content: 'no such process', is_error: true },
        ]),
      ).toBe('running');
    });

    it.each([
      ['fuser -k N/tcp', 'fuser -k 9123/tcp'],
      [
        'Stop-Process по -LocalPort',
        'Stop-Process -Id (Get-NetTCPConnection -LocalPort 9123).OwningProcess',
      ],
      ['npx kill-port', 'npx kill-port 9123'],
      // Холодная проверка 29.09 (N5): тело оболочки в кавычках — сама команда.
      [
        'powershell -Command в кавычках',
        'powershell -Command "Get-NetTCPConnection -LocalPort 9123 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"',
      ],
      ['bash -c в кавычках', 'bash -c "kill $(lsof -ti:9123)"'],
    ])('%s — killed', (_name, command) => {
      expect(statusAfter(command)).toBe('killed');
    });

    // N5: порт берётся из поиска, а не из всей строки.
    it('погашен другой порт, а 9123 лишь спрошен curl — сервер идёт', () => {
      expect(statusAfter('lsof -ti:3000 | xargs kill; curl localhost:9123/health')).toBe('running');
    });

    it('grep -c "kill" — счёт строк, не погашение', () => {
      expect(statusAfter('grep -c "kill" log.txt; lsof -i:9123')).toBe('running');
    });

    // N5: netstat одним вызовом, taskkill по его PID — следующим.
    it('PID из ответа netstat, погашенный следующим вызовом, — killed', () => {
      const progress = buildProgress([
        ...vite,
        assistant(2, [bash('n', 'netstat -ano | findstr :9123')]),
        user(2, [result('n', '  TCP    0.0.0.0:9123    0.0.0.0:0    LISTENING    4567\n')]),
        assistant(3, [bash('k', 'taskkill /F /PID 4567')]),
        user(3, [result('k', 'SUCCESS')]),
      ]);
      expect(progress.shells?.[0]?.status).toBe('killed');
    });

    it('taskkill по PID, которого поиск не печатал, — сервер идёт', () => {
      expect(statusAfter('taskkill /F /PID 4567')).toBe('running');
    });

    // N5: порт во второй строке фоновой команды и ждущий по адресу.
    it('порт во второй строке фоновой команды тоже сверяется', () => {
      const progress = buildProgress([
        assistant(1, [
          bash('v', 'cd apps/host\nnpx vite --port 9123', { run_in_background: true }),
        ]),
        user(1, [result('v', 'Command running in background with ID: bvite.')]),
        assistant(2, [bash('k', 'kill $(lsof -ti:9123)')]),
        user(2, [result('k', '')]),
      ]);
      expect(progress.shells?.[0]?.status).toBe('killed');
    });

    it('wait-on по адресу сервера вместе с ним не гаснет', () => {
      const progress = buildProgress([
        ...vite,
        assistant(2, [bash('w', 'npx wait-on http://localhost:9123', { run_in_background: true })]),
        user(2, [result('w', 'Command running in background with ID: bwait.')]),
        assistant(3, [bash('k', 'kill $(lsof -ti:9123)')]),
        user(3, [result('k', '')]),
      ]);
      expect(progress.shells?.map((shell) => shell.status)).toEqual(['killed', 'running']);
    });

    // Ревью r2 (R1): фон «освободи порт и подними сервер» гасит прежний, не себя.
    it.each([
      ['kill-port', 'npx kill-port 9123 && npm run dev -- --port 9123'],
      ['lsof | xargs kill', 'lsof -ti:9123 | xargs kill -9; npm run dev -- --port 9123'],
    ])('%s в фоновой команде — прежний killed, новый идёт', (_name, command) => {
      const progress = buildProgress([
        ...vite,
        assistant(2, [bash('r', command, { run_in_background: true })]),
        user(2, [result('r', 'Command running in background with ID: brestart.')]),
      ]);
      expect(progress.shells?.map((shell) => shell.status)).toEqual(['killed', 'running']);
    });

    // R2: оболочка — только словом команды, тело — только снаружи кавычек.
    it.each([
      ['.sh-файл рядом с grep -c "kill"', 'lsof -i :9123; ./check.sh && grep -c "kill" out.log'],
      ['bash -c внутри echo', 'echo "bash -c \'kill $(lsof -ti:9123)\'" >> notes.md'],
    ])('%s — сервер идёт', (_name, command) => {
      expect(statusAfter(command)).toBe('running');
    });

    // R2: голое число в ответе вызова, который не только ищет, — не PID.
    it('код ответа curl рядом с lsof не становится PID', () => {
      const progress = buildProgress([
        ...vite,
        assistant(2, [bash('n', 'curl -s -w "%{http_code}" localhost:9123; lsof -ti:9123')]),
        user(2, [result('n', '200\n4567')]),
        assistant(3, [bash('k', 'kill 200')]),
        user(3, [result('k', '')]),
      ]);
      expect(progress.shells?.[0]?.status).toBe('running');
    });

    it('голый PID от чистого поиска гасится следующим вызовом', () => {
      const progress = buildProgress([
        ...vite,
        assistant(2, [bash('n', 'lsof -ti:9123')]),
        user(2, [result('n', '4567\n')]),
        assistant(3, [bash('k', 'kill -9 4567')]),
        user(3, [result('k', '')]),
      ]);
      expect(progress.shells?.[0]?.status).toBe('killed');
    });
  });

  it('все вызовы вернулись — текущего нет', () => {
    const progress = buildProgress([
      assistant(1, [bash('a', 'pnpm install')]),
      user(2, [result('a', 'ok')]),
    ]);

    expect(progress.activeTool).toBeUndefined();
  });
});
