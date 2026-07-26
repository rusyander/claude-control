import { describe, it, expect } from 'vitest';
import type { RunningAgent } from '@claude-control/contracts';
import {
  isClaudeAgentCommand,
  parseWindowsOutput,
  parseUnixOutput,
  createProcessScanCache,
} from './runtime.ts';

/**
 * Раздел «Работающие агенты» искал процесс с именем `claude` — а Claude Code,
 * поставленный через npm, исполняется как `node …/@anthropic-ai/claude-code/cli.js`.
 * На таких установках список был пуст всегда, и раздел выглядел сломанным.
 *
 * Теперь опознание идёт по командной строке. Опасность обратная: под неё
 * легко подводится лишнее — сама панель (её каталог зовётся claude-control),
 * MCP-серверы, запущенные Claude Code, и файлы в ~/.claude. Всё это здесь и
 * проверяется на настоящих командных строках с рабочей машины.
 */
describe('isClaudeAgentCommand — кого считаем работающим агентом', () => {
  it('npm-установка: node с путём к cli.js пакета claude-code', () => {
    const command =
      'C:\\Program Files\\nodejs\\node.exe C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    expect(isClaudeAgentCommand(command)).toBe(true);
  });

  it('нативная сборка: claude.exe в кавычках с аргументами', () => {
    const command =
      'c:\\Users\\me\\.vscode\\extensions\\anthropic.claude-code-2.1.214-win32-x64\\resources\\native-binary\\claude.exe --output-format stream-json';
    expect(isClaudeAgentCommand(command)).toBe(true);
  });

  it('unix-установка: /usr/local/bin/claude', () => {
    expect(isClaudeAgentCommand('/usr/local/bin/claude --resume abc')).toBe(true);
  });

  it('обёртка claude.cmd на Windows', () => {
    expect(
      isClaudeAgentCommand('"C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd" --version'),
    ).toBe(true);
  });

  it('сама панель агентом не считается: её каталог claude-control', () => {
    const command = '"C:\\Program Files\\nodejs\\node.exe" --experimental-strip-types src/index.ts';
    expect(isClaudeAgentCommand(command)).toBe(false);
  });

  it('сервер панели по полному пути тоже не считается', () => {
    const command =
      '"C:\\Program Files\\nodejs\\node.exe" c:\\work\\claude-control\\apps\\server\\src\\index.ts';
    expect(isClaudeAgentCommand(command)).toBe(false);
  });

  it('MCP-сервер из ~/.claude — не агент: точка перед именем каталога', () => {
    const command = 'node C:/Users/me/.claude/mcp-servers/telegram-inbox/server.mjs';
    expect(isClaudeAgentCommand(command)).toBe(false);
  });

  it('лаунчер MCP из ~/.claude — тоже не агент', () => {
    const command =
      'node C:/Users/me/.claude/mcp-launchers/with-secrets.mjs npx -y @zereight/mcp-gitlab';
    expect(isClaudeAgentCommand(command)).toBe(false);
  });

  it('посторонний node не считается', () => {
    expect(isClaudeAgentCommand('node /home/me/project/vite/bin/vite.js')).toBe(false);
  });

  it('пустая командная строка не ломает разбор', () => {
    expect(isClaudeAgentCommand('')).toBe(false);
    expect(isClaudeAgentCommand('   ')).toBe(false);
  });
});

describe('parseWindowsOutput', () => {
  const process = (command: string) => ({
    ProcessId: 42,
    Name: 'node.exe',
    CommandLine: command,
    WorkingSetSize: 314_572_800,
    CreationDate: '/Date(1782374724422)/',
  });

  it('оставляет только агентов и считает память в мегабайтах', () => {
    const stdout = JSON.stringify([
      process('node /home/me/@anthropic-ai/claude-code/cli.js'),
      process('node /home/me/project/vite.js'),
    ]);

    const agents = parseWindowsOutput(stdout);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.memoryMb).toBe(300);
  });

  it('BOM в выводе PowerShell не роняет разбор', () => {
    // Кодировка консоли зависит от системы; без снятия BOM JSON.parse падал,
    // и список молча становился пустым.
    const stdout = `\uFEFF${JSON.stringify([process('claude.exe --resume x')])}`;
    expect(parseWindowsOutput(stdout)).toHaveLength(1);
  });

  it('единственный процесс приходит объектом, а не массивом', () => {
    const stdout = JSON.stringify(process('node /home/me/claude-code/cli.js'));
    expect(parseWindowsOutput(stdout)).toHaveLength(1);
  });

  it('имя node заменяется на claude: под node работает половина машины', () => {
    const stdout = JSON.stringify([process('node /home/me/claude-code/cli.js')]);
    expect(parseWindowsOutput(stdout)[0]?.name).toBe('claude');
  });

  it('дату запуска приводит к ISO', () => {
    const stdout = JSON.stringify([process('claude.exe')]);
    expect(parseWindowsOutput(stdout)[0]?.startedAt).toBe(new Date(1782374724422).toISOString());
  });

  it('пустой вывод — пустой список', () => {
    expect(parseWindowsOutput('')).toEqual([]);
    expect(parseWindowsOutput('   ')).toEqual([]);
  });
});

/**
 * Кэш обхода процессов. Обход стоит секунды (на Windows это powershell.exe с
 * Get-CimInstance — 4-5 с на замерах), а страница аналитики опрашивает живые
 * данные раз в 5 секунд: без кэша PowerShell не выходил из памяти вовсе, и
 * КАЖДЫЙ ответ /api/analytics ждал его целиком — даже отдавая всё остальное из
 * своего кэша. Проверяем четыре свойства: повтор не сканирует, параллельные
 * вызовы делят обход, устаревшее отдаётся сразу и обновляется в фоне, а совсем
 * старое ждёт настоящий обход.
 */
describe('createProcessScanCache', () => {
  const agent = (pid: number): RunningAgent => ({ pid, name: 'claude', memoryMb: 1 });
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('в пределах TTL обход не повторяется', async () => {
    let calls = 0;
    const cached = createProcessScanCache(async () => {
      calls += 1;
      return [agent(calls)];
    }, 60_000);

    expect(await cached()).toEqual([agent(1)]);
    expect(await cached()).toEqual([agent(1)]);
    expect(calls).toBe(1);
  });

  it('параллельные вызовы делят один обход', async () => {
    let calls = 0;
    const cached = createProcessScanCache(async () => {
      calls += 1;
      await tick();
      return [agent(calls)];
    }, 60_000);

    const [first, second] = await Promise.all([cached(), cached()]);
    expect(calls).toBe(1);
    expect(first).toEqual(second);
  });

  it('устаревший список отдаётся сразу, а обновляется в фоне (регрессия)', async () => {
    let calls = 0;
    let finishSecond: ((agents: RunningAgent[]) => void) | undefined;
    const cached = createProcessScanCache(
      () => {
        calls += 1;
        if (calls === 1) return Promise.resolve([agent(1)]);
        return new Promise<RunningAgent[]>((resolve) => {
          finishSecond = resolve;
        });
        // TTL нулевой, потолок устаревания — заведомо недостижимый: здесь
        // проверяется именно фоновая ветка.
      },
      0,
      60_000,
    );

    // Первый вызов ждёт обход: показывать ещё нечего.
    expect(await cached()).toEqual([agent(1)]);

    // TTL истёк, но ответ приходит немедленно — второй обход ещё висит.
    expect(await cached()).toEqual([agent(1)]);
    expect(calls).toBe(2);

    finishSecond?.([agent(2)]);
    await tick();
    expect(await cached()).toEqual([agent(2)]);
  });

  /**
   * Регрессия: устаревание было НЕОГРАНИЧЕННЫМ. Фоновое обновление случается
   * только когда за списком приходят, поэтому после часа простоя первый же
   * ответ отдавал часовой список — а маршрут штампует его `at: сейчас`, то есть
   * давно закрытые агенты показывались работающими прямо сейчас.
   */
  it('за потолком устаревания ответ ждёт настоящий обход (регрессия)', async () => {
    let calls = 0;
    let finishSecond: ((agents: RunningAgent[]) => void) | undefined;
    const cached = createProcessScanCache(
      () => {
        calls += 1;
        if (calls === 1) return Promise.resolve([agent(1)]);
        return new Promise<RunningAgent[]>((resolve) => {
          finishSecond = resolve;
        });
      },
      0,
      0,
    );

    expect(await cached()).toEqual([agent(1)]);

    // Второй вызов не отвечает старым списком — он висит, пока обход не придёт.
    let answered: RunningAgent[] | undefined;
    const pending = cached().then((agents) => {
      answered = agents;
    });

    await tick();
    expect(calls).toBe(2);
    expect(answered).toBeUndefined();

    finishSecond?.([agent(2)]);
    await pending;
    expect(answered).toEqual([agent(2)]);
  });

  it('за потолком устаревания отказ обхода отдаёт последнее известное', async () => {
    let calls = 0;
    const cached = createProcessScanCache(
      () => {
        calls += 1;
        return calls === 1 ? Promise.resolve([agent(1)]) : Promise.reject(new Error('нет прав'));
      },
      0,
      0,
    );

    expect(await cached()).toEqual([agent(1)]);
    expect(await cached()).toEqual([agent(1)]);
  });

  it('первый вызов ждёт обход, пустой результат кэшируется как значение', async () => {
    let calls = 0;
    const cached = createProcessScanCache(async () => {
      calls += 1;
      return [];
    }, 60_000);

    expect(await cached()).toEqual([]);
    expect(await cached()).toEqual([]);
    expect(calls).toBe(1);
  });
});

describe('parseUnixOutput', () => {
  it('разбирает вывод ps и берёт только агентов', () => {
    const stdout = [
      '  123  204800 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume x',
      '  456  102400 node /home/me/project/vite.js',
      '  789   51200 /usr/local/bin/claude',
    ].join('\n');

    const agents = parseUnixOutput(stdout);
    expect(agents.map((agent) => agent.pid)).toEqual([123, 789]);
  });

  it('память из килобайтов переводит в мегабайты', () => {
    const stdout = '  123  204800 /usr/local/bin/claude';
    expect(parseUnixOutput(stdout)[0]?.memoryMb).toBe(200);
  });

  it('аргументы с пробелами не ломают разбор колонок', () => {
    const stdout = '  123  204800 /usr/local/bin/claude --name "мой чат" --resume abc';
    expect(parseUnixOutput(stdout)).toHaveLength(1);
  });

  it('заголовок и пустые строки пропускаются', () => {
    expect(parseUnixOutput('  PID   RSS COMMAND\n\n')).toEqual([]);
  });
});
