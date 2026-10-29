import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { psQuote } from '../hidden-launch.ts';

/**
 * Каталоги, на которых ломались файловые операции (F13, P26, P78): кириллица + CJK, короткое
 * имя 8.3 (только Windows) и путь длиннее 260 символов. Корень — в песочнице прогона и уходит
 * в конце теста, который его взял (F-123): вызывать только внутри `it`.
 */
export function hostileHomes(): { name: string; dir: string }[] {
  const base = mkdtempSync(join(tmpdir(), 'hostile-'));
  onTestFinished(() =>
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const nonLatin = join(base, 'задача 汉字 ü');
  mkdirSync(nonLatin, { recursive: true });
  let long = join(base, 'long');
  while (long.length < 300) long = join(long, 'segment-абвгд-0123456789');
  mkdirSync(long, { recursive: true });
  const homes = [
    { name: 'non-latin', dir: nonLatin },
    { name: 'long', dir: long },
  ];
  if (process.platform === 'win32') {
    const short = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${psQuote(nonLatin)}).ShortPath`,
      ],
      { encoding: 'utf8' },
    ).trim();
    // 8.3 выключен на томе — проверять нечего: это провал, а не тихий пропуск.
    if (!/~\d/.test(short)) throw new Error(`no 8.3 short name for ${nonLatin}: ${short}`);
    homes.push({ name: 'short-8.3', dir: short });
  }
  return homes;
}
