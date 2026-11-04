import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { samePath } from '../platform/paths.ts';

/**
 * Чей разговор (этап 10, F2; `CliAdapter.ownsTranscript`) — общая часть хранилищ вида
 * `<корень>/<папка проекта>/[<подпапка>/]<id>.jsonl`, чьи строки несут `{sessionId, cwd}`:
 * так пишут Claude Code (`projects/<проект>/<id>.jsonl`) и Qwen Code
 * (`projects/<проект>/chats/<id>.jsonl`). Имя папки проекта не разбирается — его правило CLI;
 * папку называет сам транскрипт. Файла нет или он другого корня — `false`; не читается — `undefined`.
 */

/** Голова транскрипта, в которой ищется папка разговора: первые строки несут `cwd` сразу. */
const HEAD_BYTES = 256 * 1024;

function readHead(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Папка разговора: первая строка этого id с `cwd`; оборванная последняя строка головы не в счёт. */
function transcriptCwd(head: string, conversationId: string): string | undefined {
  const lines = head.split('\n');
  if (head.length >= HEAD_BYTES) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const r = row as { cwd?: unknown; sessionId?: unknown };
    if (r.sessionId === conversationId && typeof r.cwd === 'string' && r.cwd) return r.cwd;
  }
  return undefined;
}

export function ownsJsonlTranscript(
  projects: string,
  sub: string | null,
  root: string,
  conversationId: string,
): boolean | undefined {
  if (!existsSync(projects)) return false;
  const file = `${conversationId}.jsonl`;
  let found: string[];
  try {
    found = readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        sub ? join(projects, entry.name, sub, file) : join(projects, entry.name, file),
      )
      .filter((path) => existsSync(path));
  } catch {
    return undefined;
  }
  if (found.length === 0) return false;
  let unread = false;
  for (const path of found) {
    let cwd: string | undefined;
    try {
      cwd = transcriptCwd(readHead(path), conversationId);
    } catch {
      unread = true;
      continue;
    }
    // Ни одной строки этого id с папкой — не транскрипт этого разговора (копия под чужим именем).
    if (cwd !== undefined && samePath(cwd, root)) return true;
  }
  return unread ? undefined : false;
}
