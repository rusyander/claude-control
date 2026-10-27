import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Скиллы наблюдения за группами (`watchdog`, `agentdeck-watchdog`) едут в наборе: на машине без личной копии
 * в ~/.claude наблюдатель запускается из набора. Здесь — то, что делает их переносимыми:
 *  - снимок текстов правил наблюдателя (rule-texts.json) совпадает с модулем панели, из которого он снят;
 *  - в публичном репозитории под скиллами нет путей чужой машины, имён компаний и русских описаний;
 *  - пункт Stop `watch-keepalive` набора держит ход наблюдателя по своему реестру (<kit state>/watchers),
 *    отпускает на hold.json и «все группы закончены» и молчит, пока тот же ход держит личный двойник —
 *    иначе один конец хода получил бы два отказа;
 *  - cmd-duration набора не гонит блокирующий вызов наблюдения в фон (фон = ход кончился, наблюдение уснуло);
 *  - каждый файл скиллов зарегистрирован двойником в twins.json.
 * Всё через настоящие входы: диспетчер событий `hooks/lib/run.mjs`, как его зовёт hooks.json, и скрипт
 * наблюдения из копии набора — он сам пишет запись реестра, которую потом читает пункт Stop.
 */

const KIT = process.env.AGENTDECK_KIT_UNDER_TEST || builtinKitDir();
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const SKILLS = ['watchdog', 'agentdeck-watchdog'].map((s) => join(KIT, 'skills', s));
const dir = mkdtempSync(join(tmpdir(), 'kit-watchdog-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
  );

describe('rule-texts.json — снимок текстов правил наблюдателя', () => {
  const lib = join(KIT, 'skills', 'agentdeck-watchdog', 'scripts', 'lib', 'rule-texts.mjs');
  const json = join(KIT, 'skills', 'agentdeck-watchdog', 'scripts', 'rule-texts.json');

  it('совпадает с group-watch/en.ts панели id в id и текст в текст', async () => {
    const { parseRuleTexts, RULE_TEXTS_SRC } = (await import(pathToFileURL(lib).href)) as {
      parseRuleTexts: (src: string) => Record<string, string>;
      RULE_TEXTS_SRC: string;
    };
    const fromRepo = parseRuleTexts(readFileSync(join(REPO, RULE_TEXTS_SRC), 'utf8'));
    const snapshot = (JSON.parse(readFileSync(json, 'utf8')) as { texts: Record<string, string> })
      .texts;
    // Пустой разбор с обеих сторон тоже «равен» — правил в модуле панели больше тридцати.
    expect(Object.keys(fromRepo).length).toBeGreaterThan(30);
    expect(snapshot).toEqual(fromRepo);
  });

  it('`rule-texts.mjs --check` из набора против этого репозитория — код 0', () => {
    const r = spawnSync(
      process.execPath,
      [
        join(KIT, 'skills', 'agentdeck-watchdog', 'scripts', 'rule-texts.mjs'),
        '--repo',
        REPO,
        '--check',
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

describe('публичный репозиторий: под скиллами наблюдения нет следов чужой машины', () => {
  const files = SKILLS.flatMap(walk);

  it('ни путей пользовательского профиля, ни коротких имён Windows, ни имени компании', () => {
    const MACHINE = [
      // C:\Users\<name>; SHORT~1 — заглушка 8.3-имени в фикстурах самопроверки
      /[A-Za-z]:[\\/]+Users[\\/]+(?!<|SHORT~1\b)[\w.-]+/i,
      /\/(?:home|Users)\/(?!<)[a-z][\w.-]*\//, // /home/<name>/
      /\b[A-Z]{6}~\d\b/, // 8.3-имя профиля
      /g[oa]rg[oa]n/i,
    ];
    const hits = files.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return MACHINE.filter((re) => re.test(text)).map((re) => `${relative(KIT, f)}: ${re}`);
    });
    expect(hits).toEqual([]);
    expect(files.length).toBeGreaterThan(25);
  });

  it('описания SKILL.md — английские, пути в тексте — от корня набора', () => {
    for (const root of SKILLS) {
      const text = readFileSync(join(root, 'SKILL.md'), 'utf8');
      const description = /^description:\s*(.+)$/m.exec(text)?.[1] ?? '';
      expect(description.length).toBeGreaterThan(40);
      expect(description).not.toMatch(/[\u0400-\u04FF]/);
    }
    const md = files.filter((f) => f.endsWith('.md'));
    const personal = md.filter((f) =>
      /~\/\.claude\/(?:skills|tools|agentdeck|hooks\/tests)\//.test(readFileSync(f, 'utf8')),
    );
    expect(personal.map((f) => relative(KIT, f))).toEqual([]);
  });
});

describe('twins.json: каждый файл скиллов наблюдения — зарегистрированный двойник', () => {
  it('скрипты и справочники — пары корня watch-skills, SKILL.md — пары корня skills', () => {
    const ledger = JSON.parse(readFileSync(join(KIT, '..', 'twins.json'), 'utf8')) as {
      pairs: Record<string, { same: boolean }>;
    };
    const unlisted = SKILLS.flatMap((root) =>
      walk(root).map((f) => {
        const rel = relative(join(KIT, 'skills'), f).split('\\').join('/');
        return /\/SKILL\.md$/.test(rel) ? `skills:${rel}` : `watch-skills:${rel}`;
      }),
    ).filter((key) => !ledger.pairs[key]);
    expect(unlisted).toEqual([]);
    // Скрипты переносятся байт в байт: пара записана как `same`.
    const scripts = Object.entries(ledger.pairs).filter(([k]) =>
      /^watch-skills:.+\/scripts\/.+$/.test(k),
    );
    expect(scripts.length).toBeGreaterThan(20);
    expect(scripts.filter(([, p]) => !p.same).map(([k]) => k)).toEqual([]);
  });
});

type StopOut = { decision?: string; reason?: string };
let n = 0;
/** Окружение одного сценария: своё состояние набора, свой каталог конфигурации, свой проект. */
function stage() {
  const root = join(dir, `s${++n}`);
  const env = {
    state: join(root, 'kit-state'),
    config: join(root, 'config'),
    project: join(root, 'project'),
  };
  for (const d of Object.values(env)) mkdirSync(d, { recursive: true });
  return env;
}
type Stage = ReturnType<typeof stage>;
function hook(s: Stage, event: 'stop' | 'post-any', payload: object) {
  const r = spawnSync(process.execPath, [DISPATCH, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_KIT_STATE: s.state,
      AGENTDECK_KIT_CLI: '',
      AGENTDECK_GROUP_STAGE: '',
      AGENTDECK_SPLIT_CHILD: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      CLAUDE_CONFIG_DIR: s.config,
    },
    timeout: 15_000,
  });
  return r.stdout.trim();
}
const stopOf = (out: string): StopOut => (out ? (JSON.parse(out) as StopOut) : {});
function transcript(s: Stage, name = 'main.jsonl') {
  const f = join(s.project, name);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(
    f,
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Watching the groups.' }] },
    }) + '\n',
  );
  return f;
}
/** Вызов наблюдения из копии набора — он сам регистрирует сессию в реестре своего слоя. */
function watchOnce(s: Stage, sid: string) {
  const unit = transcript(s, 'unit.jsonl');
  const state = join(s.project, '.agent', 'tmp', 'watchdog', 'w');
  const r = spawnSync(
    process.execPath,
    [
      join(KIT, 'skills', 'watchdog', 'scripts', 'watch.mjs'),
      '--state',
      state,
      '--unit',
      `u=file:${unit}`,
      '--once',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTDECK_KIT_STATE: s.state,
        CLAUDE_CONFIG_DIR: s.config,
        CLAUDE_CODE_SESSION_ID: sid,
      },
      timeout: 60_000,
    },
  );
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return join(s.state, 'watchers', `${sid}.json`);
}
const payload = (s: Stage, sid: string, extra: object = {}) => ({
  session_id: sid,
  transcript_path: transcript(s),
  cwd: s.project,
  ...extra,
});

describe('пункт Stop watch-keepalive набора', () => {
  it('вызов наблюдения из набора пишет в <kit state>/watchers, не в личный реестр; конец хода — отказ с командой', () => {
    const s = stage();
    const reg = watchOnce(s, 'sid-a');
    expect(existsSync(reg)).toBe(true);
    expect(existsSync(join(s.config, 'cache', 'watchers'))).toBe(false);
    const rec = JSON.parse(readFileSync(reg, 'utf8')) as { cmd: string };
    expect(rec.cmd).toContain('watch.mjs');
    const out = stopOf(hook(s, 'stop', payload(s, 'sid-a')));
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(rec.cmd);
    expect(out.reason).toContain('Block 1/3');
  });

  it('три отказа без нового вызова наблюдения — и ход отпущен; новый вызов взводит снова', () => {
    const s = stage();
    watchOnce(s, 'sid-b');
    const p = payload(s, 'sid-b');
    const seen = [1, 2, 3, 4].map(() => stopOf(hook(s, 'stop', p)).decision ?? 'pass');
    expect(seen).toEqual(['block', 'block', 'block', 'pass']);
    watchOnce(s, 'sid-b');
    expect(stopOf(hook(s, 'stop', p)).decision).toBe('block');
  });

  it('hold.json в проекте наблюдения и «все группы закончены» отпускают ход', () => {
    const s = stage();
    const reg = watchOnce(s, 'sid-c');
    const rec = JSON.parse(readFileSync(reg, 'utf8')) as { repo: string };
    mkdirSync(join(rec.repo, '.agent', 'live-watch'), { recursive: true });
    writeFileSync(join(rec.repo, '.agent', 'live-watch', 'hold.json'), '{}');
    expect(hook(s, 'stop', payload(s, 'sid-c'))).toBe('');
    rmSync(join(rec.repo, '.agent', 'live-watch', 'hold.json'));
    writeFileSync(reg, JSON.stringify({ ...JSON.parse(readFileSync(reg, 'utf8')), allDone: true }));
    expect(hook(s, 'stop', payload(s, 'sid-c'))).toBe('');
  });

  it('личный двойник установлен и держит тот же ход — пункт набора молчит; без живой записи двойника — блокирует', () => {
    const s = stage();
    watchOnce(s, 'sid-d');
    mkdirSync(join(s.config, 'hooks', 'lib'), { recursive: true });
    writeFileSync(join(s.config, 'hooks', 'lib', 'watch-keepalive.mjs'), '// personal twin\n');
    // Двойник установлен, но этот ход в его реестре не записан — держать некому, держит набор.
    expect(stopOf(hook(s, 'stop', payload(s, 'sid-d'))).decision).toBe('block');
    mkdirSync(join(s.config, 'cache', 'watchers'), { recursive: true });
    writeFileSync(
      join(s.config, 'cache', 'watchers', 'sid-d.json'),
      JSON.stringify({ at: Date.now(), cmd: 'node watch.mjs --state x' }),
    );
    expect(hook(s, 'stop', payload(s, 'sid-d'))).toBe('');
    // Запись двойника устарела (12 ч) — снова держит набор.
    writeFileSync(
      join(s.config, 'cache', 'watchers', 'sid-d.json'),
      JSON.stringify({ at: Date.now() - 13 * 3600e3, cmd: 'node watch.mjs --state x' }),
    );
    expect(stopOf(hook(s, 'stop', payload(s, 'sid-d'))).decision).toBe('block');
  });

  it('субагент и чужая сессия не держатся; запись после --stop удаляется', () => {
    const s = stage();
    const reg = watchOnce(s, 'sid-e');
    const sub = join(s.project, 'subagents', 'agent-1.jsonl');
    mkdirSync(join(sub, '..'), { recursive: true });
    writeFileSync(sub, '');
    expect(hook(s, 'stop', { ...payload(s, 'sid-e'), transcript_path: sub })).toBe('');
    expect(hook(s, 'stop', payload(s, 'sid-other'))).toBe('');
    writeFileSync(reg, JSON.stringify({ ...JSON.parse(readFileSync(reg, 'utf8')), stopped: true }));
    expect(hook(s, 'stop', payload(s, 'sid-e'))).toBe('');
    expect(existsSync(reg)).toBe(false);
  });

  it('post-any: 10 мин без вызова наблюдения — одна строка тревоги с командой, повтор не раньше чем через 10 мин', () => {
    const s = stage();
    const reg = watchOnce(s, 'sid-f');
    const p = payload(s, 'sid-f', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(hook(s, 'post-any', p)).not.toContain('WATCH DEAD');
    const rec = JSON.parse(readFileSync(reg, 'utf8')) as { at: number; cmd: string };
    writeFileSync(reg, JSON.stringify({ ...rec, at: Date.now() - 11 * 60e3 }));
    const first = hook(s, 'post-any', p);
    expect(first).toContain('WATCH DEAD');
    expect(first).toContain('watch.mjs');
    expect(hook(s, 'post-any', p)).not.toContain('WATCH DEAD');
  });

  it('пункт стоит последним в Stop и в post-any манифеста', async () => {
    const { MANIFEST } = (await import(
      pathToFileURL(join(KIT, 'hooks', 'lib', 'items.mjs')).href
    )) as {
      MANIFEST: Record<string, string[]>;
    };
    expect(MANIFEST.stop?.at(-1)).toBe('watch-keepalive');
    expect(MANIFEST['post-any']?.at(-1)).toBe('watch-keepalive');
  });
});

describe('cmd-duration набора: блокирующий вызов наблюдения не гонится в фон', () => {
  it('убитый на потолке вызов наблюдения — только совет по таймауту; обычная команда — в фон', async () => {
    const lib = (await import(
      pathToFileURL(join(KIT, 'hooks', 'lib', 'cmd-duration.mjs')).href
    )) as {
      isBlockingWatch: (c: string) => boolean;
      commandKey: (cwd: string, command: string) => string;
      knownFor: (store: object, cwd: string, command: string) => { wait?: boolean } | null;
      verdict: (o: object) => string | null;
    };
    const watch = `node ${KIT}/skills/agentdeck-watchdog/scripts/watch-groups.mjs --state s`;
    const other = 'node tools/slow.mjs';
    expect(lib.isBlockingWatch(watch)).toBe(true);
    expect(lib.isBlockingWatch(other)).toBe(false);
    // Обе команды выучены одинаково: 600 с и одно убийство на потолке.
    const killed = { runs: [600], kills: 1, last: Date.now() };
    const store = {
      keys: { [lib.commandKey(dir, watch)]: killed, [lib.commandKey(dir, other)]: killed },
      pending: {},
    };
    const known = (command: string) => lib.knownFor(store, dir, command);
    expect(known(watch)?.wait).toBe(true);
    const say = (command: string, subagent: boolean) =>
      lib.verdict({ known: known(command), background: false, timeoutMs: 600_000, subagent }) ?? '';
    expect(say(watch, false)).not.toMatch(/run_in_background: true/);
    expect(say(other, false)).toMatch(/run_in_background: true/);
    // Субагенту (вспомогательный вызов наблюдения) «сузь или раздели» тоже не говорится.
    expect(say(watch, true)).not.toMatch(/Narrow it/);
    expect(say(other, true)).toMatch(/Narrow it/);
  });
});
