import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexAppServerTurn, codexThreadRights } from './codex-app-server.ts';
import { GooseAcpTurn } from './goose-acp.ts';
import { KimiServerTurn } from './kimi-server.ts';
import { QwenServeTurn } from './qwen-serve.ts';
import type { LivePermissionAsk, LiveTurn, LiveTurnOptions, LiveTurnResult } from './types.ts';

/**
 * Живой ход (В1) на подделках серверных режимов: настоящий дочерний процесс,
 * настоящий stdio / HTTP / SSE, протокол — тот, что снят с CLI живыми пробами.
 * Подменён только сам CLI; с настоящими CLI тот же путь гоняет
 * `tools/qa/check-foreign-steer.mjs`.
 */

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Запуск CLI ведёт в подделку: argv тот же, что ушёл бы настоящему CLI. */
function spawnInto(file: string): LiveTurnOptions['spawnImpl'] {
  return ((_command: string, args: string[], options: object) =>
    spawn(
      process.execPath,
      [fixture(file), ...args],
      options,
    )) as unknown as LiveTurnOptions['spawnImpl'];
}

function options(file: string, env: Record<string, string>): LiveTurnOptions {
  return {
    command: process.execPath,
    prompt: 'вопрос человека',
    timeoutMs: 15_000,
    env,
    spawnImpl: spawnInto(file),
  };
}

/** Прогон, в котором сообщение посреди ответа уходит, как только ход стал «принимающим». */
async function runWithSteer(
  turn: LiveTurn,
  opts: LiveTurnOptions,
  text: string,
): Promise<{ result: LiveTurnResult; steered: boolean[]; deltas: string; steerable: number }> {
  const steered: boolean[] = [];
  let deltas = '';
  let steerable = 0;
  let pending: Promise<void> | undefined;
  const result = await turn.run(
    opts,
    (delta) => (deltas += delta),
    () => {
      steerable += 1;
      pending = turn.steer(text).then((ok) => void steered.push(ok));
    },
  );
  await pending;
  return { result, steered, deltas, steerable };
}

describe('codex app-server: сообщение посреди хода', () => {
  it('принятое сообщение отвечено в том же ходе, второй кусок — с новой строки', async () => {
    const turn = new CodexAppServerTurn();
    const run = await runWithSteer(
      turn,
      options('fake-codex-app-server.mjs', { FAKE_MODE: 'ok', HOLD_MS: '10000' }),
      'ещё учти X',
    );
    expect(run.steerable).toBe(1);
    expect(run.steered).toEqual([true]);
    expect(run.result).toEqual({
      kind: 'done',
      reply: 'ответ на рос человека\n\nучёл: ещё учти X',
    });
    expect(run.deltas).toBe('ответ на рос человека\n\nучёл: ещё учти X');
  });

  it('ход кончился — сообщение не принято, а не потеряно молча', async () => {
    const turn = new CodexAppServerTurn();
    const result = await turn.run(
      options('fake-codex-app-server.mjs', { FAKE_MODE: 'ok', HOLD_MS: '10' }),
      () => {},
    );
    expect(result.kind).toBe('done');
    expect(await turn.steer('опоздал')).toBe(false);
  });

  it('нет подкоманды app-server — unavailable, вызывающий идёт одиночным запуском', async () => {
    const turn = new CodexAppServerTurn();
    const result = await turn.run(
      options('fake-codex-app-server.mjs', { FAKE_MODE: 'no-server' }),
      () => {},
      () => expect.unreachable('ход не начинался'),
    );
    expect(result.kind).toBe('unavailable');
  });

  it('ход упал — ошибка CLI доходит текстом', async () => {
    const turn = new CodexAppServerTurn();
    const result = await turn.run(
      options('fake-codex-app-server.mjs', { FAKE_MODE: 'fail' }),
      () => {},
    );
    expect(result).toEqual({ kind: 'error', error: 'model refused' });
  });

  it('остановка посреди хода оставляет напечатанное ответом', async () => {
    const turn = new CodexAppServerTurn();
    const result = await turn.run(
      options('fake-codex-app-server.mjs', { FAKE_MODE: 'ok', HOLD_MS: '5000' }),
      () => {},
      () => setTimeout(() => turn.stop(), 100),
    );
    expect(result).toEqual({ kind: 'done', reply: 'ответ на рос человека' });
  });
});

describe('qwen serve: сообщение посреди хода', () => {
  it('во время инструмента — встаёт в тот же ход', async () => {
    const turn = new QwenServeTurn();
    const run = await runWithSteer(
      turn,
      // Окно подделки ждёт сообщение долго, но снимается им сразу: при полном
      // прогоне под нагрузкой 400 мс по умолчанию не хватало, и шаг уходил в простой.
      options('fake-qwen-serve.mjs', { FAKE_MODE: 'inject', HOLD_MS: '10000' }),
      'и про Y',
    );
    expect(run.steered).toEqual([true]);
    expect(run.result).toEqual({ kind: 'done', reply: 'ответ на рос человека / учёл: и про Y' });
  });

  it('ход успел кончиться — подхваченное следующим запросом отвечено целиком, дольше окна ожидания', async () => {
    // Окно ожидания подхвата 100 мс, ответ на подхваченное идёт 600 мс: окно,
    // не снятое подхватом, оборвало бы этот ответ на полуслове.
    const turn = new QwenServeTurn({ graceMs: 100 });
    const run = await runWithSteer(
      turn,
      options('fake-qwen-serve.mjs', { FAKE_MODE: 'pending', ANSWER_MS: '600', HOLD_MS: '10000' }),
      'и про Z',
    );
    expect(run.steered).toEqual([true]);
    expect(run.result).toEqual({ kind: 'done', reply: 'ответ на рос человека\n\nучёл: и про Z' });
  });

  it('поток событий обогнал ответ «принято» — сообщение всё равно принято и отвечено', async () => {
    // Под нагрузкой turn_complete приходил раньше ответа на POST: ход закрывался,
    // POST обрывался, и принятое CLI сообщение считалось непринятым.
    for (const mode of ['inject', 'pending']) {
      const turn = new QwenServeTurn({ graceMs: 2_000 });
      const run = await runWithSteer(
        turn,
        options('fake-qwen-serve.mjs', {
          FAKE_MODE: mode,
          HOLD_MS: '10000',
          ACCEPT_DELAY_MS: '300',
        }),
        'и про W',
      );
      expect(run.steered, mode).toEqual([true]);
      expect(run.result.kind, mode).toBe('done');
      expect(run.result.kind === 'done' && run.result.reply, mode).toContain('учёл: и про W');
    }
  });

  it('сессия простаивает — сообщение не принято', async () => {
    const turn = new QwenServeTurn();
    const result = await turn.run(
      options('fake-qwen-serve.mjs', { FAKE_MODE: 'inject', HOLD_MS: '10' }),
      () => {},
    );
    expect(result.kind).toBe('done');
    expect(await turn.steer('опоздал')).toBe(false);
  });

  it('просьба о разрешении получает отказ, как у неинтерактивного qwen -p', async () => {
    const turn = new QwenServeTurn();
    const result = await turn.run(
      options('fake-qwen-serve.mjs', { FAKE_MODE: 'permission' }),
      () => {},
    );
    expect(result).toEqual({ kind: 'done', reply: 'ответ на рос человека / разрешение: cancel' });
  });

  it('промпт ждёт, пока qwen поднимет серверы MCP', async () => {
    // qwen 0.25 поднимает MCP фоном после POST /session, а serve живёт один
    // ответ — промпт, ушедший сразу, не видел медленного сервера (переходник
    // Jira, npx) ни в одном ходе.
    const turn = new QwenServeTurn();
    const result = await turn.run(
      options('fake-qwen-serve.mjs', { FAKE_MODE: 'mcp', HOLD_MS: '10', MCP_MS: '800' }),
      () => {},
    );
    expect(result).toEqual({ kind: 'done', reply: 'ответ на рос человека / mcp: есть' });
  });

  it('зависший сервер MCP не держит ход дольше потолка', async () => {
    const turn = new QwenServeTurn({ mcpWaitMs: 400 });
    const started = Date.now();
    const result = await turn.run(
      options('fake-qwen-serve.mjs', { FAKE_MODE: 'mcp', HOLD_MS: '10', MCP_MS: '60000' }),
      () => {},
    );
    expect(result).toEqual({ kind: 'done', reply: 'ответ на рос человека / mcp: нет' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('serve не поднялся — unavailable', async () => {
    const turn = new QwenServeTurn();
    const result = await turn.run(
      options('fake-qwen-serve.mjs', { FAKE_MODE: 'no-server' }),
      () => {},
    );
    expect(result.kind).toBe('unavailable');
  });
});

describe('goose acp: сообщение посреди хода', () => {
  /** Запуск в подделку с записью её stderr — по нему видно удаление сессии. */
  function watched(env: Record<string, string>): { opts: LiveTurnOptions; stderr: () => string } {
    let stderr = '';
    const opts = options('fake-goose-acp.mjs', env);
    const inner = opts.spawnImpl!;
    return {
      opts: {
        ...opts,
        spawnImpl: ((...args: Parameters<typeof inner>) => {
          const child = inner(...args);
          child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
          return child;
        }) as typeof inner,
      },
      stderr: () => stderr,
    };
  }

  it('принятое сообщение отвечено в том же ходе; сессия по концу удалена, как у --no-session', async () => {
    const turn = new GooseAcpTurn();
    const { opts, stderr } = watched({ FAKE_MODE: 'ok' });
    const run = await runWithSteer(turn, opts, 'и про W');
    expect(run.steerable).toBe(1);
    expect(run.steered).toEqual([true]);
    expect(run.result).toEqual({ kind: 'done', reply: 'ответ на рос человека\n\nучёл: и про W' });
    expect(stderr()).toContain('session deleted');
  });

  it('ход кончился — сообщение не принято', async () => {
    const turn = new GooseAcpTurn();
    const result = await turn.run(
      options('fake-goose-acp.mjs', { FAKE_MODE: 'ok', HOLD_MS: '10' }),
      () => {},
    );
    expect(result.kind).toBe('done');
    expect(await turn.steer('опоздал')).toBe(false);
  });

  it('просьба о разрешении получает отказ', async () => {
    const turn = new GooseAcpTurn();
    const result = await turn.run(
      options('fake-goose-acp.mjs', { FAKE_MODE: 'permission', HOLD_MS: '10' }),
      () => {},
    );
    expect(result).toEqual({
      kind: 'done',
      reply: 'ответ на рос человека / разрешение: reject_once',
    });
  });

  it('остановка — мягкая отмена хода, напечатанное остаётся ответом', async () => {
    const turn = new GooseAcpTurn();
    const { opts, stderr } = watched({ FAKE_MODE: 'ok', HOLD_MS: '5000' });
    const result = await turn.run(
      opts,
      () => {},
      () => setTimeout(() => turn.stop(), 100),
    );
    expect(result).toEqual({ kind: 'done', reply: 'ответ на рос человека' });
    expect(stderr()).toContain('session deleted');
  });

  it('нет подкоманды acp — unavailable', async () => {
    const turn = new GooseAcpTurn();
    const result = await turn.run(
      options('fake-goose-acp.mjs', { FAKE_MODE: 'no-server' }),
      () => {},
    );
    expect(result.kind).toBe('unavailable');
  });
});

describe('kimi web: сообщение посреди хода', () => {
  /** Запуск в подделку с записью её stderr — по нему видно удаление сессии. */
  function watched(env: Record<string, string>): { opts: LiveTurnOptions; stderr: () => string } {
    let stderr = '';
    const opts = options('fake-kimi-server.mjs', env);
    const inner = opts.spawnImpl!;
    return {
      opts: {
        ...opts,
        spawnImpl: ((...args: Parameters<typeof inner>) => {
          const child = inner(...args);
          child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
          return child;
        }) as typeof inner,
      },
      stderr: () => stderr,
    };
  }

  it('сообщение влито в тот же ход; модель из конфига в каждом запросе; сессия удалена', async () => {
    const turn = new KimiServerTurn({ pollMs: 50 });
    const { opts, stderr } = watched({ FAKE_MODE: 'ok' });
    const run = await runWithSteer(turn, opts, 'и про V');
    expect(run.steerable).toBe(1);
    expect(run.steered).toEqual([true]);
    expect(run.result).toEqual({ kind: 'done', reply: 'ответ на рос человека\n\nучёл: и про V' });
    expect(run.deltas).toBe('ответ на рос человека\n\nучёл: и про V');
    expect(stderr()).toContain('session deleted');
  });

  it('ход успел кончиться — CLI начинает сообщение следующим ходом, прогон ждёт его ответа', async () => {
    // Ответ на саму отправку задержан на 300 мс (сессия уже простаивает), ответ
    // модели на сообщение идёт 600 мс — оба дольше шага опроса: прогон, решивший
    // «ход кончился» по первому `busy:false`, потерял бы сообщение.
    const turn = new KimiServerTurn({ pollMs: 50 });
    const run = await runWithSteer(
      turn,
      options('fake-kimi-server.mjs', {
        FAKE_MODE: 'late',
        ANSWER_MS: '600',
        REPLY_DELAY_MS: '300',
      }),
      'и про U',
    );
    expect(run.steered).toEqual([true]);
    expect(run.result).toEqual({ kind: 'done', reply: 'ответ на рос человека\n\nследом: и про U' });
  });

  it('ход кончился — сообщение не принято', async () => {
    const turn = new KimiServerTurn({ pollMs: 50 });
    const result = await turn.run(
      options('fake-kimi-server.mjs', { FAKE_MODE: 'ok', HOLD_MS: '10' }),
      () => {},
    );
    expect(result.kind).toBe('done');
    expect(await turn.steer('опоздал')).toBe(false);
  });

  it('просьба о разрешении получает отказ', async () => {
    const turn = new KimiServerTurn({ pollMs: 50 });
    const result = await turn.run(
      options('fake-kimi-server.mjs', { FAKE_MODE: 'permission', HOLD_MS: '5000' }),
      () => {},
    );
    expect(result).toEqual({
      kind: 'done',
      reply: 'ответ на рос человека\n\nразрешение: rejected',
    });
  });

  it('ход провален без ответа — ошибка CLI доходит текстом', async () => {
    const turn = new KimiServerTurn({ pollMs: 50 });
    const result = await turn.run(options('fake-kimi-server.mjs', { FAKE_MODE: 'fail' }), () => {});
    expect(result).toEqual({ kind: 'error', error: 'model refused' });
  });

  it('остановка посреди хода оставляет напечатанное ответом, сессия удалена', async () => {
    const turn = new KimiServerTurn({ pollMs: 50 });
    const { opts, stderr } = watched({ FAKE_MODE: 'ok', HOLD_MS: '5000' });
    const result = await turn.run(
      opts,
      () => {},
      () => setTimeout(() => turn.stop(), 300),
    );
    expect(result).toEqual({ kind: 'done', reply: 'ответ на рос человека' });
    expect(stderr()).toContain('session deleted');
  });

  it('нет подкоманды web — unavailable', async () => {
    const turn = new KimiServerTurn({ pollMs: 50 });
    const result = await turn.run(
      options('fake-kimi-server.mjs', { FAKE_MODE: 'no-server' }),
      () => {},
    );
    expect(result.kind).toBe('unavailable');
  });
});

describe('права хода: переключатель «Разрешить правки» и вопрос человеку', () => {
  type Make = () => LiveTurn;
  const cases: {
    cli: string;
    make: Make;
    file: string;
    env: Record<string, string>;
    allow: string;
    deny: string;
  }[] = [
    {
      cli: 'codex',
      make: () => new CodexAppServerTurn(),
      file: 'fake-codex-app-server.mjs',
      env: { FAKE_MODE: 'permission' },
      allow: 'разрешение: accept',
      deny: 'разрешение: decline',
    },
    {
      cli: 'qwen',
      make: () => new QwenServeTurn(),
      file: 'fake-qwen-serve.mjs',
      env: { FAKE_MODE: 'permission' },
      allow: 'разрешение: proceed_once',
      deny: 'разрешение: cancel',
    },
    {
      cli: 'goose',
      make: () => new GooseAcpTurn(),
      file: 'fake-goose-acp.mjs',
      env: { FAKE_MODE: 'permission', HOLD_MS: '10' },
      allow: 'разрешение: allow_once',
      deny: 'разрешение: reject_once',
    },
    {
      cli: 'kimi',
      make: () => new KimiServerTurn({ pollMs: 50 }),
      file: 'fake-kimi-server.mjs',
      env: { FAKE_MODE: 'permission', HOLD_MS: '5000' },
      allow: 'разрешение: approved',
      deny: 'разрешение: rejected',
    },
  ];

  for (const c of cases) {
    it(`${c.cli}: правки разрешены — CLI получает «да» без вопроса`, async () => {
      const asked: unknown[] = [];
      const result = await c.make().run(
        {
          ...options(c.file, c.env),
          permission: { allowEdits: true, ask: async (r) => (asked.push(r), 'deny') },
        },
        () => {},
      );
      expect(result.kind).toBe('done');
      expect(result.kind === 'done' && result.reply).toContain(c.allow);
      expect(asked).toEqual([]);
    });

    it(`${c.cli}: правки выключены — вопрос уходит человеку, его «да» доходит до CLI`, async () => {
      const asked: { cli: string; requestId: string }[] = [];
      const result = await c.make().run(
        {
          ...options(c.file, c.env),
          permission: {
            allowEdits: false,
            ask: async (r) => {
              asked.push(r);
              await new Promise((resolve) => setTimeout(resolve, 100));
              return 'allow';
            },
          },
        },
        () => {},
      );
      expect(asked).toHaveLength(1);
      expect(asked[0]?.cli).toBe(c.cli);
      expect(asked[0]?.requestId).toBeTruthy();
      expect(result.kind === 'done' && result.reply).toContain(c.allow);
    });

    it(`${c.cli}: правки выключены — «нет» человека и сбой вопроса дают отказ, не «да»`, async () => {
      const no = await c
        .make()
        .run(
          { ...options(c.file, c.env), permission: { allowEdits: false, ask: async () => 'deny' } },
          () => {},
        );
      expect(no.kind === 'done' && no.reply).toContain(c.deny);
      const broken = await c.make().run(
        {
          ...options(c.file, c.env),
          permission: {
            allowEdits: false,
            ask: async () => {
              throw new Error('панель ушла');
            },
          },
        },
        () => {},
      );
      expect(broken.kind === 'done' && broken.reply).toContain(c.deny);
      const silent = await c
        .make()
        .run({ ...options(c.file, c.env), permission: { allowEdits: false } }, () => {});
      expect(silent.kind === 'done' && silent.reply).toContain(c.deny);
    });
  }
});

describe('codex app-server: права потока по переключателю', () => {
  const rightsOf = async (permission: LiveTurnOptions['permission']): Promise<string> => {
    const result = await new CodexAppServerTurn().run(
      {
        ...options('fake-codex-app-server.mjs', { FAKE_MODE: 'permission' }),
        ...(permission ? { permission } : {}),
      },
      () => {},
    );
    return result.kind === 'done' ? result.reply : `не done: ${JSON.stringify(result)}`;
  };

  it('правки разрешены — без карточки: workspace-write, а на Windows «да» отвечает панель', async () => {
    const reply = await rightsOf({ allowEdits: true, ask: async () => 'deny' });
    if (process.platform === 'win32') {
      expect(reply).toContain('права: read-only/untrusted');
      // Человека не спросили (его ответ был бы «нет») — «да» дала сама панель.
      expect(reply).toContain('разрешение: accept');
    } else {
      expect(reply).toContain('права: workspace-write/never');
    }
  });

  it('просьба о команде: человек видит саму команду, его «да» и «нет» доходят до CLI', async () => {
    const env = { FAKE_MODE: 'permission', FAKE_APPROVAL: 'command' };
    const asked: LivePermissionAsk[] = [];
    const yes = await new CodexAppServerTurn().run(
      {
        ...options('fake-codex-app-server.mjs', env),
        permission: { allowEdits: false, ask: async (r) => (asked.push(r), 'allow') },
      },
      () => {},
    );
    expect(asked).toEqual([
      expect.objectContaining({ tool: 'command', title: 'Set-Content probe.txt edited' }),
    ]);
    expect(yes.kind === 'done' && yes.reply).toContain('разрешение: accept');
    const no = await new CodexAppServerTurn().run(
      {
        ...options('fake-codex-app-server.mjs', env),
        permission: { allowEdits: false, ask: async () => 'deny' },
      },
      () => {},
    );
    expect(no.kind === 'done' && no.reply).toContain('разрешение: decline');
  });

  it('права под платформу: workspace-write на Windows без песочницы отклоняет всё', () => {
    expect(codexThreadRights({ allowEdits: true }, 'linux')).toEqual({
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    });
    expect(codexThreadRights({ allowEdits: true }, 'win32')).toEqual({
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
    });
    expect(codexThreadRights({ allowEdits: false }, 'linux')).toEqual({
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
    });
    expect(codexThreadRights(undefined, 'win32')).toEqual({ approvalPolicy: 'never' });
  });

  it('правки выключены — read-only, и каждое действие спрашивается (untrusted)', async () => {
    expect(await rightsOf({ allowEdits: false, ask: async () => 'deny' })).toContain(
      'права: read-only/untrusted',
    );
  });

  it('без политики — как codex exec: песочница из настроек, вопросов нет', async () => {
    const reply = await rightsOf(undefined);
    expect(reply).toContain('права: нет/never');
    // Вопрос, пришедший вопреки `never`, всё равно получает отказ, а не «да».
    expect(reply).toContain('разрешение: decline');
  });
});
