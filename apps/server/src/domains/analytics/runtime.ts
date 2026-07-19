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

async function listWindows(): Promise<RunningAgent[]> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      'Get-Process -Name claude -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,StartTime | ConvertTo-Json -Compress',
    ],
    { windowsHide: true, timeout: 10_000 },
  );

  return parseWindowsOutput(stdout);
}

function parseWindowsOutput(stdout: string): RunningAgent[] {
  if (!stdout.trim()) return [];

  const parsed = JSON.parse(stdout) as
    | Array<{ Id: number; ProcessName: string; WorkingSet64: number; StartTime?: string }>
    | { Id: number; ProcessName: string; WorkingSet64: number; StartTime?: string };

  // Один процесс PowerShell отдаёт объектом, несколько — массивом.
  const list = Array.isArray(parsed) ? parsed : [parsed];

  return list.map((item) => ({
    pid: item.Id,
    name: item.ProcessName,
    memoryMb: Math.round((item.WorkingSet64 / (1024 * 1024)) * 10) / 10,
    startedAt: normalizeWindowsDate(item.StartTime),
  }));
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
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid,comm,rss'], { timeout: 10_000 });

  return stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[1]?.includes('claude'))
    .map((parts) => ({
      pid: Number(parts[0]),
      name: parts[1] ?? 'claude',
      memoryMb: Math.round((Number(parts[2] ?? 0) / 1024) * 10) / 10,
    }));
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
