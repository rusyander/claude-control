import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import type { RunningAgent, ToolUsage } from '@claude-control/contracts';

const execFileAsync = promisify(execFile);

/**
 * Что происходит на машине прямо сейчас. Список процессов — единственный
 * честный способ увидеть работающие экземпляры Claude Code: реестра запущенных
 * агентов нигде не ведётся, поэтому смотрим на то, что реально исполняется.
 */
export async function getRunningAgents(): Promise<RunningAgent[]> {
  try {
    return process.platform === 'win32' ? await listWindows() : await listUnix();
  } catch {
    // Нет прав на перечисление процессов или другая ОС — раздел просто пуст.
    return [];
  }
}

/**
 * Опознание агента по командной строке, а не по имени процесса. Claude Code
 * запускается как `node …/@anthropic-ai/claude-code/cli.js`, поэтому поиск
 * процесса с именем `claude` не находил ничего никогда — список был пуст на
 * всех системах. Нативная сборка (`claude.exe`) при этом тоже существует,
 * так что проверяем оба вида.
 *
 * Процессы самой панели отсеиваются: её каталог называется claude-control, и
 * без этой проверки панель показывала бы в списке агентов саму себя.
 */
export function isClaudeAgentCommand(commandLine: string): boolean {
  const value = commandLine.toLowerCase();
  if (!value.trim()) return false;
  if (value.includes('claude-control')) return false;

  // Пакет CLI — самый надёжный признак: он есть в пути к cli.js.
  if (value.includes('claude-code')) return true;

  // Исполняемый файл: claude, …/claude, …\claude.cmd, "…\claude.exe" — но не
  // claude-something и не …/.claude/… (это каталог конфигурации, где живут
  // MCP-серверы и лаунчеры, а они агентами не являются). Поэтому слева —
  // начало строки, кавычка или разделитель пути, справа — конец, пробел или
  // кавычка.
  return /(^|["'\s]|[\\/](?!\.))claude(\.cmd|\.exe|\.js)?(\s|"|'|$)/.test(value);
}

interface WindowsProcess {
  ProcessId: number;
  Name: string;
  CommandLine?: string;
  WorkingSetSize?: number;
  CreationDate?: string;
}

async function listWindows(): Promise<RunningAgent[]> {
  // Фильтр по имени отсекает сотни посторонних процессов на стороне ОС:
  // разбирать командные строки всей машины было бы заметно дороже.
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='claude.exe'\" | Select-Object ProcessId,Name,CommandLine,WorkingSetSize,CreationDate | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, timeout: 10_000 },
  );

  return parseWindowsOutput(stdout);
}

export function parseWindowsOutput(stdout: string): RunningAgent[] {
  // BOM в начале вывода PowerShell зависит от кодировки консоли, а JSON.parse
  // на нём падает — снимаем до разбора, иначе список молча становится пустым.
  const raw = stdout.replace(/^\uFEFF/, '').trim();
  if (!raw) return [];

  const parsed = JSON.parse(raw) as WindowsProcess[] | WindowsProcess;

  // Один процесс PowerShell отдаёт объектом, несколько — массивом.
  const list = Array.isArray(parsed) ? parsed : [parsed];

  return list
    .filter((item) => isClaudeAgentCommand(item.CommandLine ?? ''))
    .map((item) => ({
      pid: item.ProcessId,
      name: agentName(item.Name),
      memoryMb: Math.round(((item.WorkingSetSize ?? 0) / (1024 * 1024)) * 10) / 10,
      startedAt: normalizeWindowsDate(item.CreationDate),
    }));
}

/**
 * Показывать `node` бессмысленно — под этим именем работает половина машины.
 * В списке агентов интересен сам Claude Code, поэтому имя приводим к нему.
 */
function agentName(processName: string): string {
  const base = processName.replace(/\.exe$/i, '');
  return base.toLowerCase() === 'node' ? 'claude' : base;
}

/** PowerShell отдаёт дату как /Date(1782374724422)/ либо ISO-строкой. */
function normalizeWindowsDate(value?: string): string | undefined {
  if (!value) return undefined;
  const epoch = /\/Date\((\d+)\)\//.exec(value);
  if (epoch?.[1]) return new Date(Number(epoch[1])).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

async function listUnix(): Promise<RunningAgent[]> {
  // args идёт последним и содержит пробелы, поэтому пустые заголовки (`=`)
  // и разбор по первым двум полям: остальное — командная строка целиком.
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,rss=,args='], { timeout: 10_000 });

  return parseUnixOutput(stdout);
}

export function parseUnixOutput(stdout: string): RunningAgent[] {
  const agents: RunningAgent[] = [];

  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;

    const [, pid, rss, args = ''] = match;
    if (!isClaudeAgentCommand(args)) continue;

    agents.push({
      pid: Number(pid),
      name: 'claude',
      memoryMb: Math.round((Number(rss ?? 0) / 1024) * 10) / 10,
    });
  }

  return agents;
}

/**
 * Статистика вызовов скиллов. Claude Code ведёт её сам в ~/.claude.json —
 * пересчитывать по транскриптам не нужно.
 */
export function getSkillUsage(mcpConfigPath: string): ToolUsage[] {
  if (!existsSync(mcpConfigPath)) return [];

  try {
    const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as {
      skillUsage?: Record<string, { usageCount?: number }>;
    };

    return Object.entries(config.skillUsage ?? {})
      .map(([name, value]) => ({ name, count: value.usageCount ?? 0 }))
      .filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  } catch {
    return [];
  }
}
