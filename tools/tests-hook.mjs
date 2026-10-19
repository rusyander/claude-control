#!/usr/bin/env node
/**
 * Хук блока «Тесты» для любого Claude Code над проектом — чат панели, VS Code,
 * терминал (решение владельца 15.10). Панель ставит его в
 * `<проект>/.claude/settings.local.json` (`domains/project-tests/turn-hooks`),
 * файл в git не уходит.
 *
 *   node tools/tests-hook.mjs session   SessionStart: короткая строка о блоке
 *   node tools/tests-hook.mjs stop      Stop: правил код — кейс, прогон, запись
 *
 * Экономия — главное требование: ход без правок выходит, не читая домен (один
 * запуск node, ноль токенов); пропуск — не чаще раза за ход (`stop_hook_active`),
 * и каждый пробел несёт готовую команду, чтобы лишний ход был один.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./tests-cli.mjs', import.meta.url));
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Хвост журнала, которого хватает на ход: читать журнал в мегабайты целиком на каждом Stop — дорого. */
const TAIL_BYTES = 4 * 1024 * 1024;

const event = process.argv[2];
const input = readInput();
const root = resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());

if (event === 'session') session();
else if (event === 'stop') stop();

function readInput() {
  try {
    const raw = readFileFd(0);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readFileFd(fd) {
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  for (;;) {
    let read;
    try {
      read = readSync(fd, buffer, 0, buffer.length, null);
    } catch {
      break;
    }
    if (read <= 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function session() {
  // Чат панели уже несёт полную строку о тестах в системном промпте — второй раз
  // её не повторяем (`ChatRunner` ставит переменную вместе со строкой).
  if (process.env.AGENTDECK_TESTS_NOTE) return;
  const cli = `node "${CLI}"`;
  const project = `--project "${root}"`;
  process.stdout.write(
    `AgentDeck Tests block is on for this project (cases in .agent/tests). When you change product code, keep it current in the same turn: ` +
      `add or update the covering case — ${cli} case ${project} --group <g> --json '{"title":"…","steps":["…"],"expected":"…","codePaths":["<changed path>"]}' ` +
      `(an existing test → add "automation":{"status":"automated","file":"<test path>"}); ` +
      `one step per behaviour, each expected = what is actually seen, never "all pass"/"works" (standard: ${cli} help); ` +
      `run the automated cases you touched — ${cli} run ${project} --case <g>:<id>,… (a whole --group may carry live QA against the stand); record a manual check — ${cli} record ${project} <g>:<id>=passed --note "<how>". ` +
      `The turn end checks this and names any gap.\n`,
  );
}

function stop() {
  if (input.stop_hook_active) return;
  const turn = readTurn(input.transcript_path);
  if (!turn) return;
  let files = turn.files;
  let changedAt = turn.changedAt;
  if (files.length === 0 && turn.shell) ({ files, changedAt } = dirtySince(turn.since));
  files = files
    .map((file) => (isAbsolute(file) ? relative(root, file) : file).split('\\').join('/'))
    .filter((file) => file && !file.startsWith('../') && !isAbsolute(file));
  if (files.length === 0) return;
  const result = spawnSync(
    process.execPath,
    [CLI, 'gate', '--project', root, '--since', turn.since, '--changed-at', changedAt, ...files],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );
  // Сбой самой проверки ход не держит: молчаливый пропуск честнее, чем пропуск ни о чём.
  if (result.status !== 1) return;
  const gaps = result.stdout.trim();
  if (!gaps) return;
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: `${gaps}\nClose these now. If something truly cannot be done here (no runner, no access), say so in the reply with the exact command for the user instead.`,
    }),
  );
}

/** Последний ход журнала: начало (реплика человека), правленые файлы, время последней правки. */
function readTurn(path) {
  if (!path || !existsSync(path)) return undefined;
  const lines = tail(path).split('\n');
  const files = new Set();
  let since;
  let changedAt;
  let shell = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (entry.type === 'user' && !entry.isMeta && isPrompt(content)) {
      since = entry.timestamp;
      break;
    }
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      if (EDIT_TOOLS.has(block.name)) {
        const file = block.input?.file_path ?? block.input?.notebook_path;
        if (typeof file === 'string') files.add(file);
        if (!changedAt) changedAt = entry.timestamp;
      } else if (block.name === 'Bash' || block.name === 'PowerShell') shell = true;
    }
  }
  if (!since) return undefined;
  return { since, changedAt: changedAt ?? since, files: [...files], shell };
}

/** Реплика человека, а не результат инструмента (он тоже приходит записью `user`). */
function isPrompt(content) {
  if (typeof content === 'string') return !content.startsWith('<command-name>');
  if (!Array.isArray(content)) return false;
  return (
    content.some((block) => block?.type === 'text') &&
    !content.some((block) => block?.type === 'tool_result')
  );
}

function tail(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Ход шёл через оболочку и правок инструментами нет — файлы, изменённые после его начала. */
function dirtySince(since) {
  const started = Date.parse(since);
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '-uall'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  if (status.status !== 0) return { files: [], changedAt: since };
  const files = [];
  let latest = started;
  for (const line of status.stdout.split('\n')) {
    const raw = line.slice(3).trim();
    if (!raw) continue;
    const arrow = raw.lastIndexOf(' -> ');
    const file = (arrow >= 0 ? raw.slice(arrow + 4) : raw).replace(/^"|"$/g, '');
    try {
      const mtime = statSync(join(root, file)).mtimeMs;
      if (mtime >= started) {
        files.push(file);
        latest = Math.max(latest, mtime);
      }
    } catch {
      // Удалённый файл: времени правки нет, а судить о нём нечем.
    }
  }
  return { files, changedAt: new Date(latest).toISOString() };
}
