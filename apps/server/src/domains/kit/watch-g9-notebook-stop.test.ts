import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Аудит g9 27.10 (R2): задание перепроверки просило строку в блокноте копии на каждый
 * добытый факт, а блокнот так и остался от 26.10 — два флака холодной сборки, форма ответа
 * mr_discussions, `python3` = заглушка Microsoft Store. Следующая перепроверка платила за них
 * заново. Страж `notebook-at-stop` останавливает ход группы один раз, если в нём были отказы или
 * ошибки, а блокнот не тронут. Запуск — через диспетчер событий, как его зовёт hooks.json.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kit-g9-notebook-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const COPY = join(dir, 'copy');
const BARE = join(dir, 'bare');
const NOTEBOOK = join(COPY, '.agent', 'run', 'notebook.agent.md');
mkdirSync(join(COPY, '.agent', 'run'), { recursive: true });
mkdirSync(BARE);
writeFileSync(NOTEBOOK, '# Notebook\n', 'utf8');

let n = 0;
const say = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const use = (name: string, input: object, id: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: string, isError = false) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  },
});
const answer = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

const GROUP = { AGENTDECK_GROUP_STAGE: 'recheck' };

function stop(records: object[], env: NodeJS.ProcessEnv = GROUP, extra: object = {}): string {
  const out = spawnSync(process.execPath, [DISPATCH, 'stop'], {
    input: JSON.stringify({
      hook_event_name: 'Stop',
      transcript_path: transcript(records),
      session_id: 'kit-g9-notebook',
      cwd: COPY,
      ...extra,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_KIT_STATE: join(dir, 'state'),
      AGENTDECK_GROUP_STAGE: '',
      ...env,
    },
    timeout: 15_000,
  });
  return out.stdout.trim();
}

const REFUSED =
  'PreToolUse:Bash hook error: git-guard: plain push after a non-rebase commit is refused — use --force-with-lease.';
const RULE_CARD =
  'PreToolUse:Bash hook error: rule-card: this call needs a rule this session got only as a card — the card is not the rule.';

// Ход перепроверки: отказ стража на push и ошибка python3 — два факта для блокнота.
const lessons = [
  say('Перепроверь MR'),
  use('Bash', { command: 'git push' }, 'b1'),
  result('b1', REFUSED),
  use('Bash', { command: 'python3 tools/check.py' }, 'b2'),
  result(
    'b2',
    'Python was not found; run without arguments to install from the Microsoft Store',
    true,
  ),
];
const noted = use(
  'Edit',
  {
    file_path: NOTEBOOK,
    old_string: '# Notebook',
    new_string: '# Notebook\n- python3 = Store stub',
  },
  'e1',
);

describe('notebook-at-stop: факты хода перепроверки — в блокнот копии (g9 R2)', () => {
  it('отказ и ошибка, блокнот не тронут — блок называет оба факта и блокнот', () => {
    const out = stop([...lessons, answer('Готово.')]);
    expect(out).toMatch(/notebook-at-stop: this turn hit 2 refusals or errors/);
    expect(out).toContain('git-guard: plain push after a non-rebase commit');
    expect(out).toContain('Python was not found');
    expect(out).toContain('.agent/run/notebook.agent.md');
  });

  it('блокнот правлен Edit после последнего факта — без блока', () => {
    const out = stop([...lessons, noted, result('e1', 'ok'), answer('Готово.')]);
    expect(out).not.toMatch(/notebook-at-stop/);
  });

  it('правка блокнота ДО нового отказа не закрывает его — блок', () => {
    const out = stop([
      say('Перепроверь MR'),
      noted,
      result('e1', 'ok'),
      use('Bash', { command: 'git push' }, 'b3'),
      result('b3', REFUSED),
      answer('Готово.'),
    ]);
    expect(out).toMatch(/notebook-at-stop: this turn hit 1 refusal or error /);
  });

  it('только карточка правила, отказ пользователя и ошибка Read — не факты, без блока', () => {
    const out = stop([
      say('Перепроверь MR'),
      use('Bash', { command: 'pnpm lint' }, 'c1'),
      result('c1', RULE_CARD),
      use('Bash', { command: 'rm -rf dist' }, 'c2'),
      result('c2', "The user doesn't want to proceed with this tool use."),
      use('Read', { file_path: join(COPY, 'missing.ts') }, 'c3'),
      result('c3', 'File does not exist.', true),
      answer('Готово.'),
    ]);
    expect(out).not.toMatch(/notebook-at-stop/);
  });

  it('не стадия группы, нет блокнота, повторный Stop или субагент — без блока', () => {
    const records = [...lessons, answer('Готово.')];
    expect(stop(records, {})).not.toMatch(/notebook-at-stop/);
    expect(stop(records, GROUP, { cwd: BARE })).not.toMatch(/notebook-at-stop/);
    expect(stop(records, GROUP, { stop_hook_active: true })).not.toMatch(/notebook-at-stop/);
    expect(stop(records, GROUP, { agent_id: 'a1' })).not.toMatch(/notebook-at-stop/);
  });

  it('факты из прошлых реплик пользователя не в счёт — смотрится только текущий ход', () => {
    const out = stop([...lessons, answer('Готово.'), say('спасибо'), answer('Пожалуйста.')]);
    expect(out).not.toMatch(/notebook-at-stop/);
  });
});
