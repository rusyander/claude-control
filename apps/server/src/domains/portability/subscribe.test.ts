import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANON_VERSION, type AgentEnvironment } from '@agentdeck/contracts/portable-env';
import type { EnvSubscription } from '@agentdeck/contracts/portable-subscribe';
import { claudeProvider } from '../../providers/claude.ts';
import { CATALOG_PROVIDERS } from '../../providers/catalog.ts';
import { importEnvironment } from './import/index.ts';
import { applyTransfer } from './apply.ts';
import {
  emptySubscription,
  markProjection,
  planSubscriptionSync,
  subscriptionKey,
} from './subscribe.ts';

/**
 * Подписка: пересобирается разошедшееся, и только оно (П5.1).
 *
 * Проверка идёт по НАСТОЯЩИМ файлам: временный дом, настоящий импортёр собирает
 * канон, настоящие эмиттеры пишут проекцию, настоящее применение кладёт её на
 * диск. Рукотворный канон, поданный прямо в расчёт, доказал бы таблицу
 * отпечатков — а вопрос тикета в том, СКОЛЬКО ФАЙЛОВ ЦЕЛИ меняет одна правка,
 * и ответить на него может только диск.
 *
 * Дом цели снимается побайтно до и после каждого действия: «ничего не удалено»
 * и «удалено то, чего мы не заметили» на глаз неразличимы.
 */

const savedEnv = { ...process.env };
let home: string;
let backupDir: string;

const gemini = CATALOG_PROVIDERS.find((provider) => provider.id === 'gemini');
if (!gemini) throw new Error('в каталоге нет провайдера gemini');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'portability-subscribe-'));
  backupDir = join(home, 'backups');
  for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  delete process.env.CLAUDE_CONFIG_DIR;

  writePanelHome();
  writeTargetHome();
});

afterEach(() => {
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

function put(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/**
 * Канон панели: две команды, две записи инструкций, скилл, права и переменная.
 *
 * Команды выбраны слоем для приёмочного случая не случайно: у Gemini каждая из
 * них — свой файл (`commandsConfig`), а вопрос критерия ровно про число файлов.
 * Скилл здесь ради противоположного случая — механизма под него у Gemini нет.
 */
function writePanelHome(): void {
  const claude = join(home, '.claude');
  put(
    join(claude, 'settings.json'),
    JSON.stringify({
      env: { EDITOR: 'code' },
      permissions: { allow: ['Bash(git status)'], deny: ['Read(./private)'] },
    }),
  );
  put(
    join(claude, 'CLAUDE.md'),
    ['Преамбула панели.', '', '## ПРАВИЛО: первое', 'Тело первого.', ''].join('\n'),
  );
  writeCommand('release', 'Тело выпуска.');
  writeCommand('review', 'Тело ревью.');
  put(
    join(claude, 'skills', 'doc-hygiene', 'SKILL.md'),
    ['---', 'name: doc-hygiene', 'description: Порядок', '---', '', 'Тело гигиены.', ''].join('\n'),
  );
}

function writeCommand(name: string, body: string): void {
  put(
    join(home, '.claude', 'commands', `${name}.md`),
    ['---', `description: Команда ${name}`, '---', '', body, ''].join('\n'),
  );
}

/**
 * Дом ЦЕЛИ до подписки: файл человека, которого панель не писала. Пустой дом
 * не отличил бы «не тронули» от «тронули и вернули как было».
 */
function writeTargetHome(): void {
  put(join(home, '.gemini', 'GEMINI.md'), 'Мой собственный текст.\n');
  put(join(home, '.gemini', 'settings.json'), JSON.stringify({ theme: 'мой' }));
}

function canon(): AgentEnvironment {
  return importEnvironment({ provider: claudeProvider, scope: 'global' });
}

/**
 * Снимок дома цели: путь → содержимое, плюс отметка каталога. Каталоги в снимке
 * не для полноты — проекция скилла это папка, и «файл убрали, папку оставили»
 * отличается от «не тронули» только здесь.
 */
function snapshotTarget(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        files.set(path, '<каталог>');
        walk(path);
      } else files.set(path, readFileSync(path).toString('hex'));
    }
  };
  walk(join(home, '.gemini'));
  return files;
}

/** Пути файлов, чьё СОДЕРЖИМОЕ отличается между двумя снимками. */
function changedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

function subscribe(layers: EnvSubscription['layers']): EnvSubscription {
  return { ...emptySubscription(gemini!.id, 'global', CANON_VERSION), layers };
}

/**
 * Один круг подписки — ровно то же, что делает маршрут: посчитать, записать,
 * запомнить. Отдельного пути у теста нет намеренно: путь, которым проверяют,
 * обязан быть путём, которым работают.
 */
function sync(
  subscription: EnvSubscription,
  env = canon(),
): { subscription: EnvSubscription; plan: ReturnType<typeof planSubscriptionSync>['plan'] } {
  const { plan, writes, landed, root } = planSubscriptionSync(
    env,
    subscription,
    gemini!,
    { scope: 'global' },
    '2026-09-21T10:00:00.000Z',
  );
  if (root === null) return { subscription, plan };

  const files = plan.transfer
    ? applyTransfer(plan.transfer.target, plan.transfer.root, writes, backupDir)
    : [];
  return {
    subscription: markProjection(
      subscription,
      env,
      landed,
      files,
      root,
      '2026-09-21T10:00:00.000Z',
    ),
    plan,
  };
}

describe('ключ подписки', () => {
  it('разводит уровни и проекты: память одной не отвечает за другую', () => {
    expect(subscriptionKey('gemini', 'global')).toBe('gemini:global');
    expect(subscriptionKey('gemini', 'project', 'p1')).toBe('gemini:project@p1');
    expect(subscriptionKey('gemini', 'project', 'p1')).not.toBe(
      subscriptionKey('gemini', 'project', 'p2'),
    );
  });
});

describe('первая пересборка', () => {
  it('каждая запись подписанного слоя — новая, и проекция появляется на диске', () => {
    const { subscription, plan } = sync(subscribe(['command']));

    expect(plan.hold).toBeNull();
    expect(plan.rows.every((row) => row.state === 'new')).toBe(true);
    expect(plan.rows).toHaveLength(2);
    expect(existsSync(join(home, '.gemini', 'commands'))).toBe(true);
    expect(Object.keys(subscription.marks)).toHaveLength(2);
    expect(subscription.syncedAt).toBe('2026-09-21T10:00:00.000Z');
  });

  it('неподписанный слой не едет вовсе: права остаются у цели нетронутыми', () => {
    const before = readFileSync(join(home, '.gemini', 'settings.json'), 'utf8');
    sync(subscribe(['command']));

    // settings.json — файл прав и переменных у Gemini. Подписка на команды его
    // не касается, и «заодно перенесли остальное» здесь было бы поломкой.
    expect(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8')).toBe(before);
  });

  it('запись, которой у цели негде лежать, не объявляется спроецированной', () => {
    const before = snapshotTarget();
    const { subscription, plan } = sync(subscribe(['skill']));

    // Механизма скиллов у Gemini нет: правок ноль, файлов ноль. Пометь панель
    // такую запись спроецированной — подписка сказала бы «согласовано» про то,
    // чего у цели нет и не будет, и расхождение исчезло бы из виду навсегда.
    expect(plan.transfer).toBeNull();
    expect(plan.rows.every((row) => row.state === 'new')).toBe(true);
    expect(subscription.marks).toEqual({});
    expect(snapshotTarget()).toEqual(before);
  });
});

describe('правка канона', () => {
  it('меняет РОВНО ОДИН файл цели — критерий приёмки П5.1', () => {
    const first = sync(subscribe(['command']));
    const before = snapshotTarget();

    writeCommand('review', 'Тело ревью стало другим.');
    const second = sync(first.subscription);

    const changed = changedBetween(before, snapshotTarget());
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('review');

    const drifted = second.plan.rows.filter((row) => row.state === 'changed');
    expect(drifted).toHaveLength(1);
    expect(second.plan.rows.filter((row) => row.state === 'unchanged')).toHaveLength(1);
    // План переноса несёт ровно ту правку, что поедет: строка про совпавшую
    // запись в нём — обещание записи, которой не будет.
    expect(second.plan.transfer?.files).toHaveLength(1);
    expect(second.plan.transfer?.entries.map((entry) => entry.itemId)).toEqual([
      drifted[0]!.itemId,
    ]);
  });

  it('совпавший канон не даёт ни плана, ни записи', () => {
    const first = sync(subscribe(['command']));
    const before = snapshotTarget();

    const second = sync(first.subscription);

    expect(second.plan.transfer).toBeNull();
    expect(second.plan.hold).toBeNull();
    expect(second.plan.rows.every((row) => row.state === 'unchanged')).toBe(true);
    expect(snapshotTarget()).toEqual(before);
  });

  it('слой, который цель собирает в ОДИН файл, переписывается со всеми записями', () => {
    const first = sync(subscribe(['instructions']));
    const target = join(home, '.gemini', 'GEMINI.md');
    expect(readFileSync(target, 'utf8')).toContain('Тело первого.');

    put(
      join(home, '.claude', 'CLAUDE.md'),
      ['Преамбула панели стала другой.', '', '## ПРАВИЛО: первое', 'Тело первого.', ''].join('\n'),
    );
    sync(first.subscription);

    // Разошлась одна запись из двух, но блок собирается целиком: отбор по
    // ЗАПИСИ, а не по правке, стёр бы здесь соседнюю запись.
    const text = readFileSync(target, 'utf8');
    expect(text).toContain('Преамбула панели стала другой.');
    expect(text).toContain('Тело первого.');
  });
});

describe('своё и чужое у цели', () => {
  it('чужую запись с тем же именем подписка не переписывает', () => {
    // Панель сюда ещё ничего не проецировала: файл завёл человек. Разница с
    // каноном здесь — столкновение (инвариант 10), а не устаревшая проекция.
    const human = join(home, '.gemini', 'commands', 'review.toml');
    put(human, 'prompt = "Человеческий текст"\n');

    const { subscription, plan } = sync(subscribe(['command']));

    expect(readFileSync(human, 'utf8')).toBe('prompt = "Человеческий текст"\n');
    // Вторая команда при этом доезжает: столкновение — про одну запись.
    expect(existsSync(join(home, '.gemini', 'commands', 'release.toml'))).toBe(true);
    expect(Object.keys(subscription.marks)).toEqual(['command:release']);
    expect(plan.rows.filter((row) => row.state === 'new')).toHaveLength(2);
  });

  it('свою прошлую проекцию переписывает без вопросов', () => {
    const first = sync(subscribe(['command']));
    writeCommand('review', 'Тело ревью стало другим.');
    const second = sync(first.subscription);

    // Тот же файл, та же разница «на диске не то, что в каноне» — но писала его
    // панель, и возвращать человеку выбор значило бы спрашивать, переписывать
    // ли то, что он просил переписывать.
    expect(second.plan.transfer).not.toBeNull();
    expect(readFileSync(join(home, '.gemini', 'commands', 'review.toml'), 'utf8')).toContain(
      'стало другим',
    );
  });
});

describe('исчезнувшая запись', () => {
  it('названа строкой, но у цели не удаляется', () => {
    const first = sync(subscribe(['command']));
    const before = snapshotTarget();

    rmSync(join(home, '.claude', 'commands', 'review.md'), { force: true });
    const second = sync(first.subscription);

    const gone = second.plan.rows.filter((row) => row.state === 'gone');
    expect(gone).toHaveLength(1);
    expect(gone[0]!.kind).toBe('command');
    // Снять запись у чужого CLI — действие, обратного которому у подписки нет;
    // это разговор П5.2, а не побочный эффект пересборки.
    expect(snapshotTarget()).toEqual(before);
  });

  it('остаётся названной и на следующем круге: отметка не забывается', () => {
    const first = sync(subscribe(['command']));
    rmSync(join(home, '.claude', 'commands', 'review.md'), { force: true });
    const second = sync(first.subscription);
    const third = sync(second.subscription);

    expect(third.plan.rows.filter((row) => row.state === 'gone')).toHaveLength(1);
  });
});

describe('отписка', () => {
  it('ничего не удаляет у цели — критерий приёмки П5.1', () => {
    const first = sync(subscribe(['command']));
    const before = snapshotTarget();

    const off = { ...first.subscription, layers: [] };
    const after = sync(off);

    expect(after.plan.hold).toBe('no_layers');
    expect(after.plan.transfer).toBeNull();
    expect(snapshotTarget()).toEqual(before);
  });

  it('не выдаёт записи отписанного слоя за исчезнувшие', () => {
    const first = sync(subscribe(['command', 'instructions']));
    const narrowed = sync({ ...first.subscription, layers: ['instructions'] });

    // Отписка от слоя у цели ничего не трогает. Строка «запись исчезла» на
    // каждую команду прочиталась бы как удаление — и была бы ложью про диск.
    expect(narrowed.plan.rows.some((row) => row.state === 'gone')).toBe(false);
    expect(narrowed.plan.rows.every((row) => row.kind === 'instructions')).toBe(true);
  });

  it('помнит спроецированное: повторная подписка не объявляет всё новым', () => {
    const first = sync(subscribe(['command']));
    const back = sync({ ...first.subscription, layers: ['command'] });

    expect(back.plan.rows.every((row) => row.state === 'unchanged')).toBe(true);
  });
});

describe('версия канона', () => {
  it('другая версия удерживает пересборку и не даёт ни одной строки', () => {
    const first = sync(subscribe(['command']));
    const before = snapshotTarget();

    const older: EnvSubscription = { ...first.subscription, canonVersion: CANON_VERSION - 1 };
    const held = sync(older);

    expect(held.plan.hold).toBe('canon_version');
    expect(held.plan.transfer).toBeNull();
    // Строк нет намеренно: «разошлось/совпало», посчитанное несравнимыми
    // правилами, человек прочитал бы как факт о своих файлах.
    expect(held.plan.rows).toHaveLength(0);
    expect(snapshotTarget()).toEqual(before);
  });
});
