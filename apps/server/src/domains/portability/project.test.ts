import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { AgentEnvironment } from '@agentdeck/contracts/portable-env';
import { claudeProvider } from '../../providers/claude.ts';
import { CATALOG_PROVIDERS } from '../../providers/catalog.ts';
import type { ConfigProvider } from '../../providers/types.ts';
import { UnsafeProjectPathError } from '../provider-projects.ts';
import { linkSharedDirs } from '../project-git/mirror-local.ts';
import { emitEnvironment } from './emit/index.ts';
import { buildFidelityReport } from './fidelity-report.ts';
import { importEnvironment } from './import/index.ts';
import { buildTransferPlan } from './plan.ts';
import {
  claudeProjectPaths,
  projectSupport,
  sectionTargets,
  ProjectLevelUnsupportedError,
  ProjectRootRequiredError,
} from './project.ts';

/**
 * Уровень проекта (П2.5): тот же канон, но корнем проекта.
 *
 * Проверка идёт НА ЖИВЫХ ФАЙЛАХ и настоящими половинами переноса: временный дом,
 * временный проект, настоящий импортёр читает их с диска, настоящий эмиттер
 * раскладывает результат по файлам. Рукотворный паспорт, поданный прямо в
 * эмиттер, доказал бы таблицу, а вопрос этой волны ровно в том, В КАКОЙ ФАЙЛ
 * попадает запись, когда уровней два.
 *
 * Дом и проект несут РАЗНЫЕ маркеры: без них «паспорт проекта» и «паспорт дома»
 * отличались бы только пометкой уровня, а собранный не теми путями остался бы
 * зелёным — проверка, которая не может покраснеть, украшение.
 */

/** Слово, которое лежит только в доме. */
const HOME_MARKER = 'МАРКЕР-ДОМА-3e91a4';
/** Слово, которое лежит только в проекте. */
const PROJECT_MARKER = 'МАРКЕР-ПРОЕКТА-5c07f2';

let root: string;
/** Домашний каталог Claude (он же `override`). */
let home: string;
/** Корень проекта: `CLAUDE.md` в нём самом, настройки — в `.claude/`. */
let project: string;
const savedEnv = { ...process.env };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'portability-project-'));
  home = join(root, 'home');
  project = join(root, 'repo');

  // Дома чужих CLI считаются от домашнего каталога ПРИ ВЫЗОВЕ: без подмены
  // проверка читала бы настоящий дом человека.
  for (const key of ['HOME', 'USERPROFILE']) process.env[key] = join(root, 'foreign');
  process.env.CODEX_HOME = join(root, 'foreign', '.codex');
  delete process.env.CLAUDE_CONFIG_DIR;

  writeHome(home);
  writeProject(project);
});

afterAll(() => {
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
    // Присвоение `undefined` записало бы строку «undefined» — переменную надо
    // именно убрать, иначе следующий файл тестов читал бы несуществующий дом.
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** Дом Claude: правило, скилл, право и переменная — по представителю на раздел. */
function writeHome(dir: string): void {
  put(join(dir, 'CLAUDE.md'), `Преамбула дома. ${HOME_MARKER}\n`);
  put(
    join(dir, 'settings.json'),
    JSON.stringify({
      env: { EDITOR: 'code' },
      permissions: { allow: ['Bash(git status)'], deny: ['Read(./private)'] },
    }),
  );
  put(
    join(dir, 'skills', 'domashniy', 'SKILL.md'),
    ['---', 'name: domashniy', 'description: Скилл дома', '---', '', HOME_MARKER, ''].join('\n'),
  );
}

/** Проект: те же разделы, но по проектной раскладке Claude. */
function writeProject(dir: string): void {
  put(join(dir, 'CLAUDE.md'), `Преамбула проекта. ${PROJECT_MARKER}\n`);
  put(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(pnpm test:*)'] } }),
  );
  put(
    join(dir, '.claude', 'skills', 'proektnyy', 'SKILL.md'),
    ['---', 'name: proektnyy', 'description: Скилл проекта', '---', '', PROJECT_MARKER, ''].join(
      '\n',
    ),
  );
  put(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { proektnyy: { command: 'npx', args: ['-y', 'mcp-proekt'] } } }),
  );
}

/** Паспорт уровня проекта. */
function projectPassport(provider: ConfigProvider = claudeProvider): AgentEnvironment {
  return importEnvironment({ provider, scope: 'project', projectRoot: project, override: home });
}

/** Паспорт уровня дома. */
function homePassport(provider: ConfigProvider = claudeProvider): AgentEnvironment {
  return importEnvironment({ provider, scope: 'global', override: home });
}

/** Содержимое всех файлов дерева: путь от корня → текст. Пустое дерево — пустая карта. */
function treeSnapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      // По ссылке не идём: у копии репозитория `.claude/skills` — junction на
      // оригинал, и обход по нему сравнивал бы каталог сам с собой.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path);
      else files.set(relative(dir, path).split(sep).join('/'), readFileSync(path, 'utf8'));
    }
  };
  walk(dir);
  return files;
}

/** Провайдер, у которого проектного уровня нет: `projectConfig` не задокументирован. */
function withoutProjectLevel(provider: ConfigProvider): ConfigProvider {
  const { projectConfig: _dropped, ...rest } = provider;
  return { ...rest, capabilities: { ...provider.capabilities, projects: 'unsupported' } };
}

describe('пути уровня строятся из относительных путей провайдера', () => {
  it('каждый проектный путь Claude лежит ВНУТРИ названного корня', () => {
    const paths = claudeProjectPaths(project);
    const targets = sectionTargets(claudeProvider, 'project', { projectRoot: project });

    for (const value of [...Object.values(paths), targets.root]) {
      expect(typeof value === 'string' && value.startsWith(project)).toBe(true);
    }
    // `CLAUDE.md` проекта лежит в КОРНЕ репозитория, а не внутри `.claude/`:
    // собранный «как дома» файл CLI бы не прочитал.
    expect(paths.claudeMd).toBe(join(project, 'CLAUDE.md'));
    expect(paths.settings).toBe(join(project, '.claude', 'settings.json'));
    // Файла секретов панели у проекта нет вовсе — не пустая строка, а отсутствие.
    expect(paths.secretsEnv).toBeUndefined();
  });

  it('глобальный уровень не изменился ни на байт: те же цели, что и до П2.5', () => {
    const global = sectionTargets(claudeProvider, 'global', { override: home });

    expect(global.scope).toBe('global');
    expect(global.supported).toBe(true);
    expect(global.root).toBe(home);
    // `override` уважает только Claude, и уровень на это не влияет.
    expect(sectionTargets(claudeProvider, 'global', {}).root).not.toBe(home);
  });

  it('уровень проекта без корня — названный отказ, а не подстановка дома', () => {
    // Подставленный дом записал бы проектную настройку туда, где она действует
    // на ВСЕ проекты человека сразу, и узнал бы он об этом по поведению.
    expect(() => sectionTargets(claudeProvider, 'project', {})).toThrow(ProjectRootRequiredError);
  });

  it('относительный путь, выходящий за корень, отсекается — файла не появляется', () => {
    const codex = CATALOG_PROVIDERS.find((provider) => provider.id === 'codex');
    if (!codex) throw new Error('провайдера codex нет в каталоге');
    const escaping: ConfigProvider = {
      ...codex,
      projectConfig: { ...codex.projectConfig, instructions: '../ВНЕ-ПРОЕКТА.md' },
    };

    expect(() => sectionTargets(escaping, 'project', { projectRoot: project })).toThrow(
      UnsafeProjectPathError,
    );
    expect(treeSnapshot(root).has('ВНЕ-ПРОЕКТА.md')).toBe(false);
  });

  it('чужой CLI получает проектные пути из своего projectConfig, а не из раскладки Claude', () => {
    for (const provider of CATALOG_PROVIDERS) {
      const targets = sectionTargets(provider, 'project', { projectRoot: project });
      expect(targets.supported, provider.id).toBe(true);
      // Список разделов НЕ выписан руками: у aider проектные инструкции — это
      // список ссылок, а не файл, и выписанная тройка «файл, MCP, права» давала
      // бы ему ноль путей, то есть проверяла бы не то, что называет.
      const files = [
        targets.instructionsFile,
        targets.instructionsList?.configPath,
        targets.instructionsRules?.rulesDir,
        targets.mcp?.filePath,
        targets.env?.filePath,
        targets.permissions?.filePath,
        targets.hooks?.filePath,
        targets.skills?.skillsDir,
        targets.plugins?.pluginsDir,
      ].filter((value): value is string => typeof value === 'string');
      expect(files.length, provider.id).toBeGreaterThan(0);
      for (const file of files)
        expect(file.startsWith(project), `${provider.id}: ${file}`).toBe(true);
    }
  });
});

describe('уровень, которого у провайдера нет', () => {
  const orphan = () => withoutProjectLevel(CATALOG_PROVIDERS[0] as ConfigProvider);

  it('назван неподдержанным с причиной, а не «сделаем как глобальный»', () => {
    const support = projectSupport(orphan());

    expect(support.supported).toBe(false);
    expect(support.why ?? '').not.toBe('');
    // Корень при этом остаётся проектным: подстановка дома — та самая ложь,
    // которую критерий 2 запрещает.
    const targets = sectionTargets(orphan(), 'project', { projectRoot: project });
    expect(targets.root).toBe(project);
    expect(targets.supported).toBe(false);
  });

  it('импорт отвечает пропусками с причиной, а не записями чужого уровня', () => {
    const passport = importEnvironment({
      provider: orphan(),
      scope: 'project',
      projectRoot: project,
    });

    expect(passport.items).toHaveLength(0);
    expect(passport.skipped.length).toBeGreaterThan(0);
    expect(passport.skipped.every((skip) => skip.reason === 'no_section')).toBe(true);
    for (const skip of passport.skipped) expect(skip.detail).not.toBe('');
  });

  it('перенос на этот уровень отказывается, а не пишет в дом', () => {
    const env = homePassport();
    const before = treeSnapshot(root);

    expect(() =>
      emitEnvironment(env, { target: orphan(), scope: 'project', projectRoot: project }),
    ).toThrow(ProjectLevelUnsupportedError);
    expect(treeSnapshot(root)).toEqual(before);
  });
});

describe('план переноса на уровень проекта', () => {
  /**
   * Отчёт верности внутри плана отказывается считаться без разделов цели
   * (fail-closed), и план его не передавал: проектный перенос падал на первой же
   * строке отчёта — то есть весь уровень был недостижим с экрана.
   *
   * Сверка идёт с отчётом, посчитанным по ЯВНО названным проектным разделам:
   * «не упало» доказало бы только отсутствие исключения, а вопрос в том, ПО
   * КАКИМ фактам отчёт посчитан.
   */
  it('считается по разделам проекта, а не по профилю дома', () => {
    const env = projectPassport();
    const deps = { scope: 'project' as const, projectRoot: project, override: home };
    const computedAt = '2026-09-21T10:00:00.000Z';

    const { plan } = buildTransferPlan(env, claudeProvider, deps, computedAt);

    expect(plan.report.scope).toBe('project');
    expect(plan.report.rows.length).toBeGreaterThan(0);
    expect(plan.report).toEqual(
      buildFidelityReport(
        env,
        claudeProvider,
        computedAt,
        sectionTargets(claudeProvider, 'project', { projectRoot: project, override: home }),
      ),
    );
  });
});

describe('уровни не задевают друг друга (критерий 3)', () => {
  it('паспорт проекта собран из файлов проекта, паспорт дома — из файлов дома', () => {
    const inProject = JSON.stringify(projectPassport());
    const inHome = JSON.stringify(homePassport());

    expect(projectPassport().scope).toBe('project');
    expect(inProject).toContain(PROJECT_MARKER);
    expect(inProject).not.toContain(HOME_MARKER);

    expect(homePassport().scope).toBe('global');
    expect(inHome).toContain(HOME_MARKER);
    expect(inHome).not.toContain(PROJECT_MARKER);
  });

  it('пустой раздел называет каталог, в который смотрели, а не общий корень', () => {
    // Живой прогон 20.09.2026: все пустые разделы проекта назывались
    // `<проект>/.claude`, включая инструкции, — а `CLAUDE.md` проекта лежит в
    // КОРНЕ репозитория. Человек шёл искать файл не туда.
    const bare = join(root, 'bare-repo');
    mkdirSync(bare, { recursive: true });
    const skips = importEnvironment({
      provider: claudeProvider,
      scope: 'project',
      projectRoot: bare,
    }).skipped;

    const instructions = skips.find((skip) => skip.kind === 'instructions');
    expect(instructions?.detail).toContain(bare);
    expect(instructions?.detail).not.toContain(join(bare, '.claude'));
    expect(skips.find((skip) => skip.kind === 'skill')?.detail).toContain(
      join(bare, '.claude', 'skills'),
    );
    expect(skips.find((skip) => skip.kind === 'mcpServer')?.detail).toContain(
      join(bare, '.mcp.json'),
    );
  });

  it('корень паспорта — корень УРОВНЯ, а не дома', () => {
    // Живой прогон 20.09.2026: паспорт проекта называл корнем домашний каталог,
    // хотя все его записи приехали из репозитория. Корень человек читает на
    // экране и видит в имени резервной копии — назвать чужой каталог значит
    // соврать о происхождении каждой записи сразу.
    expect(projectPassport().root).toBe(project);
    expect(homePassport().root).toBe(home);

    for (const provider of CATALOG_PROVIDERS) {
      const passport = importEnvironment({ provider, scope: 'project', projectRoot: project });
      expect(passport.root, provider.id).toBe(project);
    }
  });

  it('перенос в проект не трогает дом цели, а перенос в дом — файлы проекта', () => {
    const env = homePassport();
    // Цель — Claude в ОТДЕЛЬНОМ доме: перенос «на другую машину», где у цели
    // свои файлы и свой проект. Оба уровня в одном прогоне, как требует критерий.
    const targetHome = join(root, 'target-home');
    const targetProject = join(root, 'target-repo');
    mkdirSync(targetProject, { recursive: true });
    writeProject(targetProject);
    const target = { target: claudeProvider, override: targetHome };

    const homeBefore = treeSnapshot(targetHome);
    const projectPlan = emitEnvironment(env, {
      ...target,
      scope: 'project',
      projectRoot: targetProject,
    });
    for (const write of projectPlan.writes) write.apply();

    // Уровень проекта записан, а дом цели не изменился НИ ОДНИМ файлом.
    // Корень плана — корень ПРОЕКТА: он уезжает в имя резервной копии и в
    // строку «что меняется», и дом цели там назвал бы не тот каталог.
    expect(projectPlan.root).toBe(targetProject);
    expect(readFileSync(join(targetProject, 'CLAUDE.md'), 'utf8')).toContain(HOME_MARKER);
    expect(treeSnapshot(targetHome)).toEqual(homeBefore);
    for (const write of projectPlan.writes)
      expect(write.filePath.startsWith(targetProject)).toBe(true);

    // И обратно: глобальный перенос в тот же дом не трогает файлы проекта.
    const projectAfterFirst = treeSnapshot(targetProject);
    const globalPlan = emitEnvironment(env, { ...target, scope: 'global' });
    for (const write of globalPlan.writes) write.apply();

    expect(treeSnapshot(targetProject)).toEqual(projectAfterFirst);
    expect(treeSnapshot(targetHome).size).toBeGreaterThan(0);
    for (const write of globalPlan.writes)
      expect(write.filePath.startsWith(targetProject)).toBe(false);
  });

  it('проектный перенос к чужому CLI кладёт файлы в проект, а не в его дом', () => {
    const env = homePassport();
    const codex = CATALOG_PROVIDERS.find((provider) => provider.id === 'codex');
    if (!codex) throw new Error('провайдера codex нет в каталоге');

    const foreign = join(root, 'foreign');
    const targetProject = join(root, 'codex-repo');
    mkdirSync(targetProject, { recursive: true });
    const foreignBefore = treeSnapshot(foreign);

    const plan = emitEnvironment(env, {
      target: codex,
      scope: 'project',
      projectRoot: targetProject,
    });
    for (const write of plan.writes) write.apply();

    expect(readFileSync(join(targetProject, 'AGENTS.md'), 'utf8')).toContain(HOME_MARKER);
    expect(treeSnapshot(foreign)).toEqual(foreignBefore);
  });
});

describe('параллельная копия репозитория (критерий 4)', () => {
  it('перенос в копию уживается с зеркалом: скилл идёт по ССЫЛКЕ в оригинал', () => {
    // Копия репозитория получает `.claude/skills` ССЫЛКОЙ на оригинал
    // (`project-git/mirror-local.ts`): правка скилла обязана быть видна во всех
    // копиях сразу. Перенос, заменивший ссылку каталогом, развёл бы копии молча.
    const main = join(root, 'worktree-main');
    const copy = join(root, 'worktree-copy');
    writeProject(main);
    mkdirSync(join(copy, '.claude'), { recursive: true });

    const linked = linkSharedDirs(main, copy);
    if (!linked.linked.includes('.claude/skills')) {
      // Связать не удалось (права/файловая система) — проверка не имеет предмета
      // и обязана сказать это, а не показать зелёное.
      throw new Error(`зеркало не связало .claude/skills: ${JSON.stringify(linked.failed)}`);
    }

    const env = homePassport();
    const plan = emitEnvironment(env, {
      target: claudeProvider,
      scope: 'project',
      projectRoot: copy,
    });
    for (const write of plan.writes) write.apply();

    // Ссылка цела: перенос писал ЧЕРЕЗ неё, а не поверх неё.
    expect(lstatSync(join(copy, '.claude', 'skills')).isSymbolicLink()).toBe(true);
    // И скилл лежит в ОРИГИНАЛЕ — одной копией на все параллельные каталоги.
    expect(
      readFileSync(join(main, '.claude', 'skills', 'domashniy', 'SKILL.md'), 'utf8'),
    ).toContain(HOME_MARKER);
  });
});
