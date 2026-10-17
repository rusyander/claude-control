#!/usr/bin/env node
/**
 * Измеритель расхода лимитов: куда ушло окно у сессий агента.
 *
 *   pnpm tokens <id сессии> [<id>…]          транскрипты Claude Code по id
 *   pnpm tokens --split <id родителя>         разделение целиком: родитель, группы, их ревью;
 *                                             группы в Codex и Qwen — по их журналам
 *   pnpm tokens qwen:<id чата>                разговор панели в Codex/Qwen по его журналам
 *   pnpm tokens --file <путь.jsonl>           транскрипт Claude по пути
 *   pnpm tokens --codex <rollout.jsonl>       журнал Codex
 *   pnpm tokens --qwen <chats/….jsonl>        журнал Qwen Code
 *
 * Флаги: `--config <папка>` — конфиг Claude (по умолчанию CLAUDE_CONFIG_DIR или
 * ~/.claude); `--json` — отчёт машине; `--save <файл>` — сохранить числа как
 * эталон; `--compare <файл>` — сравнить с эталоном; `--limits '{"firstContext":45000}'`
 * (или путь к JSON) — потолки, выход 1 при нарушении (для скрипта или CI; в CI
 * проекта не гоняется — потолки держат тесты, `ChatSplit.ceilings.test.ts`).
 * Выход 2 — вход не прочитан (нет сессии, испорченный файл).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(
  HERE,
  '..',
  'apps',
  'server',
  'src',
  'domains',
  'analytics',
  'token-audit',
  'token-audit.ts',
);

/**
 * Нужен ли Node флаг, чтобы читать TypeScript: до 22.18 и в 23.0–23.5 — да (23-я
 * ветка включила чтение по умолчанию в 23.6; прежде здесь была только 22-я, ревью B2-F20).
 */
export function needsStripFlag(version) {
  const [major, minor] = version.split('.').map(Number);
  return (major === 22 && minor < 18) || (major === 23 && minor < 6);
}

/** Node без чтения TypeScript по умолчанию — перезапускаем себя с флагом. */
function relaunchIfNeeded() {
  if (!needsStripFlag(process.versions.node)) return;
  if (process.execArgv.includes('--experimental-strip-types')) return;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}

function parseArgs(argv) {
  const args = { ids: [], files: [], codex: [], qwen: [], split: [] };
  const takes = new Set([
    '--split',
    '--file',
    '--codex',
    '--qwen',
    '--config',
    '--save',
    '--compare',
    '--limits',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (takes.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg}: нужно значение`);
      const key = arg.slice(2);
      if (Array.isArray(args[key])) args[key].push(value);
      else args[key] = value;
      if (key === 'file') args.files.push(value);
    } else if (arg.startsWith('--')) throw new Error(`неизвестный флаг ${arg}`);
    else args.ids.push(arg);
  }
  args.files = [...new Set(args.files)];
  return args;
}

function readLimits(value) {
  if (!value) return undefined;
  const text = existsSync(value) ? readFileSync(value, 'utf8') : value;
  return JSON.parse(text);
}

async function main() {
  relaunchIfNeeded();
  const args = parseArgs(process.argv.slice(2));
  const empty =
    !args.ids.length &&
    !args.files.length &&
    !args.codex.length &&
    !args.qwen.length &&
    !args.split.length;
  if (args.help || empty) {
    process.stdout.write(
      readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('*/')[0]
        .replace(/^#!.*\n\/\*\*\n/, '')
        .replace(/^ \* ?/gm, ''),
    );
    process.exit(empty && !args.help ? 2 : 0);
  }
  const audit = await import(pathToFileURL(MODULE).href);
  const configDir = resolve(
    args.config ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  );

  const appData = join(configDir, 'agentdeck');
  // Разговор чужого CLI — ключом панели `<cli>:<id>`, как его пишет связь разделения.
  const ids = args.ids.filter((id) => !id.includes(':'));
  const foreign = args.ids
    .filter((id) => id.includes(':'))
    .map((key) => ({
      providerId: key.slice(0, key.indexOf(':')),
      chatId: key.slice(key.indexOf(':') + 1),
    }));
  for (const parent of args.split) {
    const statePath = join(appData, 'state.json');
    if (!existsSync(statePath))
      throw new Error(`нет ${statePath} — разделение ищется по состоянию панели`);
    const chats = audit.splitChats(JSON.parse(readFileSync(statePath, 'utf8')), parent);
    ids.push(...chats.claude);
    foreign.push(...chats.foreign);
  }
  const sessions = [];
  for (const id of [...new Set(ids)]) {
    const file = audit.findClaudeTranscript(configDir, id);
    if (!file) throw new Error(`сессия ${id}: транскрипта нет в ${join(configDir, 'projects')}`);
    sessions.push(audit.auditClaudeFile(file, id));
  }
  for (const file of args.files) sessions.push(audit.auditClaudeFile(resolve(file)));
  for (const file of args.codex)
    sessions.push(await audit.auditForeignFile(resolve(file), 'codex'));
  for (const file of args.qwen) sessions.push(await audit.auditForeignFile(resolve(file), 'qwen'));
  // Все разом: журнал общего каталога делится между разговорами, а не уходит первому.
  for (const logs of await audit.foreignChatLogs({ appData, refs: foreign })) {
    if (logs.missing) process.stderr.write(`${logs.key}: ${logs.missing}\n`);
    for (const file of logs.contested ?? []) {
      process.stderr.write(`${logs.key}: журнал ${file} — чей, не понять, в счёт не взят\n`);
    }
    for (const file of logs.files) {
      const session = await audit.auditForeignFile(file, logs.kind);
      session.title = logs.title ? `${logs.key} ${logs.title}` : logs.key;
      sessions.push(session);
    }
  }
  if (sessions.length === 0) throw new Error('ни одной сессии с расходом');

  const total = audit.totalHeadline(sessions);
  const saved = {
    savedAt: new Date().toISOString(),
    sessions: sessions.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      headline: audit.headline(s),
    })),
    total,
  };
  if (args.json)
    process.stdout.write(`${JSON.stringify({ ...saved, detail: sessions }, null, 2)}\n`);
  else {
    const out = [];
    for (const session of sessions) out.push(...audit.formatSession(session), '');
    if (sessions.length > 1) out.push(...audit.formatTotal(total, sessions.length));
    process.stdout.write(`${out.join('\n')}\n`);
  }
  if (args.save) {
    writeFileSync(args.save, `${JSON.stringify(saved, null, 2)}\n`);
    process.stderr.write(`эталон сохранён: ${args.save}\n`);
  }
  if (args.compare) {
    const base = JSON.parse(readFileSync(args.compare, 'utf8'));
    process.stdout.write(
      `\nСравнение с эталоном ${args.compare} (${base.savedAt}):\n${audit.compareHeadlines(base.total, total).join('\n')}\n`,
    );
  }
  const limits = readLimits(args.limits);
  if (limits) {
    const broken = audit.checkLimits(total, limits);
    if (broken.length > 0) {
      process.stderr.write(`ПОТОЛОК ПРЕВЫШЕН:\n${broken.map((b) => `  ${b}`).join('\n')}\n`);
      process.exit(1);
    }
    process.stderr.write(`потолки в норме: ${Object.keys(limits).join(', ')}\n`);
  }
}

// Запуск только командой: тест импортирует needsStripFlag, не запуская измеритель.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(
      `token-audit: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  });
}
