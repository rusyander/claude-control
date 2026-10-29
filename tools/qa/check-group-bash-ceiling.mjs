/**
 * Живое доказательство 3.1 плана экономии: потолок таймаута Bash группы на настоящем `claude`.
 *
 * Потолок задаёт переменная CLI `BASH_MAX_TIMEOUT_MS`; модель видит его в описании
 * инструмента Bash («up to N ms»), и только до него она может поднять таймаут гейта.
 * Окружение процесса проигрывает той же переменной в settings.json человека, поэтому
 * профиль группы кладёт её в файл `--settings` (ревью B-F02). Подменена одна модель:
 * стаб вместо API Anthropic пишет тела запросов; настройки флага строит настоящий
 * `groupRunProfile`.
 *
 * Случаи (в личном settings.json одноразового каталога конфигурации):
 * - человек задал 10 мин → у группы 30 мин (настройки флага главнее личных);
 * - человек задал 60 мин → у группы 60 мин (профиль потолок не занижает);
 * - контроль: тот же человек с 10 мин без профиля → 10 мин (проба видит то, что меряет).
 *
 * Каталог прогона — вне домашней папки: CLI собирает `.claude` всех родителей.
 * Запуск: `node tools/qa/check-group-bash-ceiling.mjs`. Нужен установленный `claude`
 * (путь — `CLAUDE_CLI`); стенд и настройки человека не трогаются.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

const PREFIX = 'cc-bashceiling-';

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок ' : 'НЕТ'} ${text}`);
  if (!ok) bad += 1;
};

function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  for (const root of [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')]) {
    if (existsSync(join(root, tail))) return join(root, tail);
  }
  return '';
}

/** Каталог без `.claude` у родителей: на Windows временная папка лежит в домашней. */
function workBase() {
  for (let dir = tmpdir(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.claude'))) break;
    if (dir === parse(dir).root) return tmpdir();
  }
  // PUBLIC есть только на Windows; на Linux с TMPDIR под домом — `/tmp`.
  const pub = process.platform === 'win32' ? process.env.PUBLIC : '/tmp';
  if (pub && existsSync(pub)) return pub;
  throw new Error('нет каталога вне домашней папки: задайте PUBLIC');
}

/** Стаб API: пишет каждый запрос, отвечает словом. */
async function startStub() {
  const seen = [];
  const stub = await startStubModel({
    // Вне `/messages` (служебные пути CLI) — пустой JSON, как было у своего стаба.
    route: ({ path }) => (path.includes('/messages') ? undefined : { body: {} }),
    script: ({ request }) => {
      seen.push(request.body);
      return 'ok';
    },
  });
  return { url: stub.baseUrl, seen, close: () => stub.close() };
}

/** Потолок из описания Bash в запросе: «up to N ms» → N. */
function ceilingOf(body) {
  const bash = (body?.tools ?? []).find((tool) => tool.name === 'Bash');
  const match = /up to (\d+)\s*ms/i.exec(bash?.description ?? '');
  return match ? Number(match[1]) : null;
}

async function main() {
  const exe = resolveClaude();
  if (!exe) throw new Error('claude не найден: задайте CLAUDE_CLI');
  const { groupRunProfile } =
    await import('../../apps/server/src/domains/chat/group-profile/group-profile.ts');
  const stub = await startStub();
  const work = mkdtempSync(join(workBase(), PREFIX));
  console.log(`CLI: ${exe}\nКаталог: ${work}\n`);

  /** Один ход: личный потолок `userMs`; `profile` — с настройками флага группы. */
  async function turn(label, userMs, profile) {
    const home = join(work, label, 'home');
    const project = join(work, label, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: String(userMs) } }),
    );
    const args = ['-p', '--output-format', 'json'];
    if (profile) {
      const run = groupRunProfile({
        entries: [],
        tasksText: '',
        extra: [],
        bashCeilings: [String(userMs)],
      });
      const settingsFile = join(work, label, 'flag-settings.json');
      writeFileSync(settingsFile, JSON.stringify(run.settings));
      args.push('--settings', settingsFile);
    }
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: stub.url,
      ANTHROPIC_AUTH_TOKEN: 'bc-stub',
      ANTHROPIC_API_KEY: 'bc-stub',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      DISABLE_AUTOUPDATER: '1',
    };
    delete env.BASH_MAX_TIMEOUT_MS;
    const from = stub.seen.length;
    await new Promise((resolve) => {
      const child = spawn(exe, [...args, 'hi'], { cwd: project, env, stdio: 'ignore' });
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const body = stub.seen.slice(from).find((item) => ceilingOf(item) !== null);
    return ceilingOf(body);
  }

  const raised = await turn('raise', 600_000, true);
  check(raised === 1_800_000, `человек задал 10 мин — у группы 30 мин (в описании Bash ${raised})`);
  const kept = await turn('keep', 3_600_000, true);
  check(kept === 3_600_000, `человек задал 60 мин — профиль не занизил (${kept})`);
  const control = await turn('control', 600_000, false);
  check(control === 600_000, `контроль без профиля — личные 10 мин (${control})`);

  stub.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log(bad ? `\nПровалов: ${bad}` : '\nВсё ок');
  process.exit(bad ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
