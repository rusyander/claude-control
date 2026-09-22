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
import { basename, join } from 'node:path';
import type { AgentEnvironment } from '@agentdeck/contracts/portable-env';
import type { TransferFileRecord } from '@agentdeck/contracts/portable-transfer';
import { runtimeOnlyEntries } from '@agentdeck/contracts/portable-transfer';
import { claudeProvider } from '../../providers/claude.ts';
import { CATALOG_PROVIDERS } from '../../providers/catalog.ts';
import { setBackupKeep } from '../../lib/safe-io.ts';
import { listBackups } from '../backups.ts';
import { importEnvironment } from './import/index.ts';
import type { EmitWrite } from './emit/types.ts';
import { buildTransferPlan, type PlannedTransfer } from './plan.ts';
import {
  applyTransfer,
  revertTransfer,
  TransferBackupsDisabledError,
  TransferRolledBackError,
} from './apply.ts';

/**
 * Перенос целиком: показать, применить, отменить (П2.3).
 *
 * Проверка идёт по НАСТОЯЩИМ файлам и настоящими адаптерами: временный дом,
 * настоящий импортёр Claude собирает канон, настоящие эмиттеры строят план,
 * настоящая запись кладёт его на диск. Рукотворный план, поданный прямо в
 * применение, доказал бы таблицу, а не сделку, — а вопрос этого тикета ровно в
 * том, что остаётся на диске, когда что-то пошло не так.
 *
 * Провал вносится ОДИН — последней правкой плана (`poison`), и он обязан
 * вернуть дом цели к байтам «до». Сравнение побайтное и вместе с каталогами:
 * пустая папка скилла, оставшаяся после отката, — это не «почти как было».
 */

/** Текст человека в доме цели: перенос обязан оставить его дословно. */
const HUMAN_TEXT = 'Мой собственный текст, который панель не писала.';
/** Метка порядка байтов: в исходнике символ невидим, поэтому пишется кодом. */
const BOM = String.fromCharCode(0xfeff);

const savedEnv = { ...process.env };
let home: string;
let backupDir: string;
let env: AgentEnvironment;

const gemini = CATALOG_PROVIDERS.find((provider) => provider.id === 'gemini');
if (!gemini) throw new Error('в каталоге нет провайдера gemini');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'portability-transfer-'));
  backupDir = join(home, 'backups');
  for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  delete process.env.CLAUDE_CONFIG_DIR;

  writeSourceHome();
  writeTargetHome();
  env = importEnvironment({ provider: claudeProvider, scope: 'global' });
});

afterEach(() => {
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR']) {
    // Присвоение `undefined` записало бы строку «undefined» — переменную надо
    // именно убрать, иначе следующий файл тестов читал бы несуществующий дом.
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

function put(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** Дом-источник: по разделу на каждый слой, который цель умеет принять. */
function writeSourceHome(): void {
  const claude = join(home, '.claude');
  put(
    join(claude, 'settings.json'),
    JSON.stringify({
      env: { EDITOR: 'code' },
      permissions: { allow: ['Bash(git status)'], deny: ['Read(./private)'] },
    }),
  );
  put(join(claude, 'CLAUDE.md'), ['Преамбула источника.', ''].join('\n'));
  put(
    join(claude, 'skills', 'doc-hygiene', 'SKILL.md'),
    ['---', 'name: doc-hygiene', 'description: Порядок в документах', '---', '', 'Тело.', ''].join(
      '\n',
    ),
  );
  put(
    join(claude, 'skills', 'code-review', 'SKILL.md'),
    ['---', 'name: code-review', 'description: Ревью', '---', '', 'Второе тело.', ''].join('\n'),
  );
}

/**
 * Дом ЦЕЛИ: файл человека с меткой порядка байтов и окончаниями Windows — так
 * его оставляют Блокнот и git с `core.autocrlf`. Отмена обязана вернуть его в
 * той же форме, а не «в той же по смыслу».
 */
function writeTargetHome(): void {
  put(join(home, '.gemini', 'GEMINI.md'), `${BOM}${HUMAN_TEXT}\r\n`);
  put(join(home, '.gemini', 'settings.json'), JSON.stringify({ theme: 'мой' }));
}

function plan(): PlannedTransfer {
  return buildTransferPlan(env, gemini!, { scope: 'global' }, '2026-09-20T10:00:00.000Z');
}

/**
 * Снимок дома цели: путь → содержимое, плюс отдельная отметка каталога.
 *
 * Каталоги в снимке не для полноты: скилл у цели — это папка, и отмена, которая
 * удалила файл и оставила папку, вернула бы дом «почти как было». Отличить это
 * от настоящего возврата можно только так.
 */
function snapshotHome(root = join(home, '.gemini')): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        files.set(path, '<каталог>');
        walk(path);
      } else {
        files.set(path, readFileSync(path).toString('hex'));
      }
    }
  };
  walk(root);
  return files;
}

/** Имена копий. Каталога может не быть вовсе: копировать было нечего. */
function backupNames(): string[] {
  return existsSync(backupDir) ? readdirSync(backupDir) : [];
}

/** Правка, которая всегда проваливается: ею вносится намеренный провал. */
function poison(filePath: string): EmitWrite {
  return {
    kind: 'skill',
    itemIds: ['ядовитая'],
    filePath,
    apply: () => {
      throw new Error('запись не удалась нарочно');
    },
    applyTo: () => {
      throw new Error('запись не удалась нарочно');
    },
  };
}

describe('план переноса', () => {
  it('ничего не пишет: дом цели после расчёта тот же', () => {
    const before = snapshotHome();
    const { plan: built } = plan();

    expect(built.files.length).toBeGreaterThan(0);
    expect(snapshotHome()).toEqual(before);
    // Каталог копий тоже не трогается: предпросмотр не имеет права вытеснять
    // историю из ротации (то же решение, что у предпросмотра одной записи).
    expect(existsSync(backupDir)).toBe(false);
  });

  it('дифф считается против настоящего файла цели и виден построчно', () => {
    const instructions = plan().plan.files.find((file) => basename(file.filePath) === 'GEMINI.md');

    expect(instructions?.exists).toBe(true);
    expect(instructions?.added).toBeGreaterThan(0);
    // Текст человека остаётся строкой контекста, а не удалением: перенос
    // дописывает свой блок, а не переписывает файл.
    expect(instructions?.lines.some((line) => line.text.includes(HUMAN_TEXT))).toBe(true);
    expect(instructions?.lines.some((line) => line.kind === 'del')).toBe(false);
  });

  it('отпечаток повторяется, пока файлы не менялись, и меняется вместе с ними', () => {
    const first = plan().plan.fingerprint;
    expect(plan().plan.fingerprint).toBe(first);

    put(join(home, '.gemini', 'GEMINI.md'), `${BOM}${HUMAN_TEXT}\r\nещё строка\r\n`);
    expect(plan().plan.fingerprint).not.toBe(first);
  });

  it('отпечаток слишком большого файла меняется от правки руками, хотя диффа нет', () => {
    // Файл цели за порогом построчного сравнения: дифф не строится вовсе, и
    // строк, по которым считался отпечаток, у него нет ни одной.
    const huge = join(home, '.gemini', 'GEMINI.md');
    const filler = `${'строка текста человека, повторённая много раз'.repeat(20)}\n`;
    put(huge, `${BOM}${HUMAN_TEXT}\r\n${filler.repeat(600)}`);

    const shown = plan().plan;
    const file = shown.files.find((entry) => basename(entry.filePath) === 'GEMINI.md');
    // Без этого проверка ничего не проверяет: на непревышенном пороге отпечаток
    // держат строки, и правка ловилась бы и до починки.
    expect(file?.truncated).toBe(true);
    expect(file?.lines).toHaveLength(0);
    expect([file?.added, file?.removed]).toEqual([0, 0]);

    // Правка руками между показом и нажатием, не меняющая числа строк: ни
    // `added`, ни `removed`, ни `exists`, ни `unchanged` от неё не двигаются.
    put(huge, `${BOM}Это переписали руками.\r\n${filler.repeat(600)}`);
    expect(plan().plan.fingerprint).not.toBe(shown.fingerprint);
  });

  it('записи рантайма названы отдельно от тех, что лягут в файлы', () => {
    const built = plan().plan;
    const runtime = runtimeOnlyEntries(built);

    expect(runtime.length).toBeGreaterThan(0);
    // Записи рантайма файла не называют: подставить «ближайший» значило бы
    // утверждать о чужом конфиге то, чего никто не делал.
    for (const entry of runtime) expect(entry.file).toBeNull();
  });
});

describe('применение', () => {
  it('без каталога копий не начинается вовсе', () => {
    const before = snapshotHome();
    const { plan: built, writes } = plan();

    expect(() => applyTransfer(built.target, built.root, writes, undefined)).toThrow(
      TransferBackupsDisabledError,
    );
    expect(snapshotHome()).toEqual(before);
  });

  it('то, что показал дифф, и оказывается в файле: повторный план пуст', () => {
    const { plan: built, writes } = plan();
    applyTransfer(built.target, built.root, writes, backupDir);

    // Второй план строится по ТЕМ ЖЕ файлам, которые только что переписаны.
    // Любая правка «не как в предпросмотре» даст здесь непустой дифф.
    for (const file of plan().plan.files) {
      expect({ path: file.filePath, unchanged: file.unchanged }).toEqual({
        path: file.filePath,
        unchanged: true,
      });
    }
  });

  it('копии помечены именем провайдера и не подлежат восстановлению из ленты', () => {
    const { plan: built, writes } = plan();
    const files = applyTransfer(built.target, built.root, writes, backupDir);

    const copies = files.filter((file) => file.backupPath !== null);
    expect(copies.length).toBeGreaterThan(0);
    for (const file of copies) {
      expect(basename(file.backupPath ?? '').startsWith('gemini-')).toBe(true);
    }
    // Лента истории возвращает копии по basename файла. Копия провайдера под
    // своим именем не находится ни по одному известному пути — иначе «вернуть»
    // положило бы настройки Gemini поверх файла Claude.
    for (const entry of listBackups(backupDir)) expect(entry.canRestore).toBe(false);
  });

  /**
   * Копии файлов с ОДИНАКОВЫМ basename — на цели, которая принимает скиллы.
   *
   * У девяти чужих CLI скиллов нет вовсе (или они читают каталог Claude и копии
   * не нужны), поэтому случай ловится переносом в Claude по другому пути: оба
   * скилла кладутся в файл `SKILL.md`, и с именем копии по basename они попали
   * бы в ОДНУ ротацию — отмена не нашла бы, к чему возвращать первый.
   */
  it('у файлов с одинаковым basename копии не вытесняют друг друга', () => {
    const target = join(home, '.claude-target');
    const { plan: built, writes } = buildTransferPlan(
      env,
      claudeProvider,
      { scope: 'global', override: target },
      '2026-09-20T10:00:00.000Z',
    );
    const files = applyTransfer(built.target, built.root, writes, backupDir);

    const skills = files.filter((file) => basename(file.filePath) === 'SKILL.md');
    expect(skills.length).toBe(2);
    const copies = backupNames().filter((name) => name.includes('SKILL.md'));
    expect(copies.length).toBe(0); // файлов у цели не было — копировать нечего

    // Второй перенос в тот же дом: теперь файлы есть, и у каждого обязана
    // появиться СВОЯ копия, а не одна на двоих.
    const second = buildTransferPlan(
      env,
      claudeProvider,
      { scope: 'global', override: target },
      '2026-09-20T10:01:00.000Z',
    );
    applyTransfer(second.plan.target, second.plan.root, second.writes, backupDir);
    const skillCopies = backupNames().filter((name) => name.includes('SKILL.md'));
    expect(skillCopies.length).toBe(2);
    expect(new Set(skillCopies).size).toBe(2);
  });

  /**
   * Два переноса в РАЗНЫЕ корни — один проект, другой проект, глобальный уровень.
   *
   * Путь от корня у них совпадает дословно (`GEMINI.md` лежит в корне каждого),
   * поэтому копии ложились под одним именем и делили одну ротацию. Глубина 1 —
   * не экзотика, а настройка панели (`backupKeep`, диапазон 1..100) и та
   * граница, на которой столкновение видно сразу: второй перенос вытеснял копию
   * первого, и отмена первого умирала на несуществующем файле.
   */
  it('перенос в другой корень не вытесняет копии первого из ротации', () => {
    // Цель — Claude: из десяти CLI только у него уровень задаётся каталогом
    // (`override`), а Gemini, Cursor и OpenCode читают глобальные файлы, и двух
    // корней у них не бывает вовсе.
    const rootA = join(home, 'проект-а', '.claude');
    const rootB = join(home, 'проект-б', '.claude');
    for (const root of [rootA, rootB]) put(join(root, 'CLAUDE.md'), `${BOM}${HUMAN_TEXT}\r\n`);
    const before = snapshotHome(rootA);

    setBackupKeep(1);
    try {
      const first = buildTransferPlan(
        env,
        claudeProvider,
        { scope: 'global', override: rootA },
        '2026-09-20T10:00:00.000Z',
      );
      const files = applyTransfer(first.plan.target, first.plan.root, first.writes, backupDir);
      const copies = files.filter((file) => file.backupPath !== null);
      expect(copies.length).toBeGreaterThan(0);

      const second = buildTransferPlan(
        env,
        claudeProvider,
        { scope: 'global', override: rootB },
        '2026-09-20T10:01:00.000Z',
      );
      applyTransfer(second.plan.target, second.plan.root, second.writes, backupDir);

      // Копии первого переноса на месте — ротация у каждого корня своя.
      for (const file of copies) expect(existsSync(file.backupPath ?? '')).toBe(true);

      // И отмена первого возвращает его дом байт в байт, а не падает на ENOENT.
      const answer = revertTransfer(
        {
          source: 'claude',
          target: 'claude',
          scope: 'global',
          appliedAt: '2026-09-20T10:05:00.000Z',
          fingerprint: 'отпечаток',
          files,
        },
        [],
      );
      expect(answer.changedSince).toEqual([]);
      expect(snapshotHome(rootA)).toEqual(before);
    } finally {
      setBackupKeep(10);
    }
  });
});

/**
 * Инвариант 5: секрет не ложится на диск чужого CLI.
 *
 * Проверка идёт ПО ДИСКУ ЦЕЛИ целиком, а не по классификации записи: вопрос
 * инварианта — лежит ли значение в чужом файле, и ответить на него может только
 * обход дома цели. Маркер в значении неповторим, поэтому его отсутствие во всех
 * файлах — это ответ, а не совпадение.
 */
describe('секрет на диск цели не едет', () => {
  /** Пароль боевой базы: имени `DATABASE_URL` нет и не будет ни в одном словаре. */
  const MARKER = 'МАРКЕР-ПАРОЛЯ-9f2a';

  /** Значение маркера где-нибудь в доме цели. */
  function markerInHome(): string[] {
    return [...snapshotHome().entries()]
      .filter(([, hex]) => hex !== '<каталог>' && Buffer.from(hex, 'hex').includes(MARKER))
      .map(([path]) => path);
  }

  it('значение с учёткой внутри не уезжает — даже под именем вне словаря', () => {
    put(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        env: {
          EDITOR: 'code',
          DATABASE_URL: `postgres://admin:${MARKER}@db.internal:5432/prod`,
        },
      }),
    );
    const withSecret = importEnvironment({ provider: claudeProvider, scope: 'global' });

    // В канон значение не попадает вовсе: у записи-секрета нет поля для него.
    const item = withSecret.items.find((entry) => 'name' in entry && entry.name === 'DATABASE_URL');
    expect(item?.kind).toBe('secret');
    expect(JSON.stringify(withSecret)).not.toContain(MARKER);

    const built = buildTransferPlan(
      withSecret,
      gemini!,
      { scope: 'global' },
      '2026-09-20T10:00:00.000Z',
    );
    applyTransfer(built.plan.target, built.plan.root, built.writes, backupDir);

    expect(markerInHome()).toEqual([]);
  });

  /** Обратная сторона: обычная переменная обязана ехать, иначе отказ всеяден. */
  it('переменная без учётки внутри едет как прежде', () => {
    const { plan: built, writes } = plan();
    applyTransfer(built.target, built.root, writes, backupDir);

    expect(readFileSync(join(home, '.gemini', '.env'), 'utf8')).toContain('EDITOR=code');
  });
});

describe('провал на середине', () => {
  it('откатывает применённое: дом цели байт в байт как до переноса', () => {
    const before = snapshotHome();
    const { plan: built, writes } = plan();
    const withFailure = [...writes, poison(join(home, '.gemini', 'commands', 'нет.toml'))];

    expect(() => applyTransfer(built.target, built.root, withFailure, backupDir)).toThrow(
      TransferRolledBackError,
    );
    expect(snapshotHome()).toEqual(before);
  });

  it('называет провалившийся файл и говорит, что откат удался', () => {
    const { plan: built, writes } = plan();
    const failing = join(home, '.gemini', 'commands', 'нет.toml');

    try {
      applyTransfer(built.target, built.root, [...writes, poison(failing)], backupDir);
      expect.unreachable('применение обязано было провалиться');
    } catch (error) {
      expect(error).toBeInstanceOf(TransferRolledBackError);
      expect((error as TransferRolledBackError).filePath).toBe(failing);
      expect((error as TransferRolledBackError).rolledBack).toBe(true);
      // Причина чужого провала сохраняется: без неё человеку нечего показать.
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
  });
});

describe('отмена переноса', () => {
  function applied(): { files: TransferFileRecord[]; before: Map<string, string> } {
    const before = snapshotHome();
    const { plan: built, writes } = plan();
    return { files: applyTransfer(built.target, built.root, writes, backupDir), before };
  }

  function record(files: TransferFileRecord[]) {
    return {
      source: 'claude',
      target: 'gemini',
      scope: 'global' as const,
      appliedAt: '2026-09-20T10:05:00.000Z',
      fingerprint: 'отпечаток',
      files,
    };
  }

  it('возвращает дом цели байт в байт, включая созданные каталоги', () => {
    const { files, before } = applied();
    expect(snapshotHome()).not.toEqual(before);

    const answer = revertTransfer(record(files), []);

    expect(answer.changedSince).toEqual([]);
    expect(answer.record).toBeNull();
    expect(snapshotHome()).toEqual(before);
  });

  /**
   * Дом цели, которого не было вовсе: перенос создаёт каталоги скиллов, команд и
   * субагентов сам. Отмена обязана снять и их — файл удалён, а пустая папка
   * `skills/doc-hygiene/` осталась, это не «как до переноса»: в следующий раз
   * панель увидит у цели скилл, которого там нет.
   */
  it('снимает каталоги, которые создала сама', () => {
    const target = join(home, '.claude-target');
    const { plan: built, writes } = buildTransferPlan(
      env,
      claudeProvider,
      { scope: 'global', override: target },
      '2026-09-20T10:00:00.000Z',
    );
    expect(snapshotHome(target).size).toBe(0);

    const files = applyTransfer(built.target, built.root, writes, backupDir);
    expect(snapshotHome(target).size).toBeGreaterThan(0);

    const answer = revertTransfer(record(files), []);

    expect(answer.record).toBeNull();
    expect([...snapshotHome(target).keys()]).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });

  it('файл, изменённый человеком после переноса, не трогает и называет', () => {
    const { files } = applied();
    const touched = files[0]?.filePath ?? '';
    writeFileSync(touched, 'человек переписал это сам\n', 'utf8');
    const mine = readFileSync(touched, 'utf8');

    const answer = revertTransfer(record(files), []);

    expect(answer.changedSince).toEqual([touched]);
    expect(answer.restored).not.toContain(touched);
    expect(readFileSync(touched, 'utf8')).toBe(mine);
    // След не исчезает: в нём остаётся ровно то, что не вернули.
    expect(answer.record?.files.map((file) => file.filePath)).toEqual([touched]);
  });

  it('названный человеком файл возвращается вместе с остальными', () => {
    const { files, before } = applied();
    const touched = files[0]?.filePath ?? '';
    writeFileSync(touched, 'человек переписал это сам\n', 'utf8');

    const answer = revertTransfer(record(files), [touched]);

    expect(answer.changedSince).toEqual([]);
    expect(answer.record).toBeNull();
    expect(snapshotHome()).toEqual(before);
  });
});
