import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentEnvironmentSchema } from '@agentdeck/contracts/portable-env-schema';
import {
  countOnlyThroughPanel,
  fidelityReasons,
  summarizeFidelity,
  type FidelityReport,
} from '@agentdeck/contracts/portable-fidelity';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerPortabilityRoutes } from './portability-routes.ts';

/**
 * Паспорт среды на уровне маршрута (П0.3).
 *
 * Дом человека здесь НАСТОЯЩИЙ — временный каталог с живыми файлами, который
 * маршрут читает тем же кодом, каким читает домашний каталог на машине. Тело
 * ответа разбирается схемой канона: ответ, который не проходит собственную
 * схему, экрану не годится, а «примерно похоже» проверкой не является.
 *
 * Значение секрета в этом доме уникально, и проверка ищет его во ВСЁМ теле
 * ответа. Проверка, которая не может покраснеть, — украшение: чтобы этот тест
 * стал зелёным по ошибке, маркер должен исчезнуть из настроек, а не из ответа.
 */
describe('portability-routes: паспорт среды', () => {
  /** Значение-маркер: доехало до ответа — проверка обязана покраснеть. */
  const SECRET_VALUE = 'sk-ant-МАРКЕР-МАРШРУТА-41c8e0-НЕ-ДОЛЖЕН-УТЕЧЬ';
  /** Идентификатор записи реестра: корень проекта берётся только по нему. */
  const PROJECT_ID = 'prj-portability';
  /** Слово, которого нет в доме: по нему видно, чьи файлы прочитал паспорт. */
  const PROJECT_MARKER = 'МАРКЕР-ПРОЕКТНОГО-УРОВНЯ-7b31';

  let home: string;
  let appData: string;
  let project: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-portability-home-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-portability-data-'));
    project = mkdtempSync(join(tmpdir(), 'cc-portability-project-'));

    mkdirSync(join(home, 'skills', 'demo'), { recursive: true });
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        // Два имени НАРОЧНО: `ANTHROPIC_API_KEY` секретом считало и прежнее
        // правило раздела, `OPENAI_KEY` — нет, и его значение уезжало в ответ
        // открытым текстом. Правило теперь общее с остальной панелью.
        env: { EDITOR: 'code', ANTHROPIC_API_KEY: SECRET_VALUE, OPENAI_KEY: SECRET_VALUE },
        permissions: { allow: ['Bash(git push:*)'], deny: ['Read(./private)'] },
      }),
    );
    writeFileSync(join(home, 'CLAUDE.md'), '# Правила\n\nтекст инструкций\n');
    writeFileSync(
      join(home, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: показательный скилл\n---\n\nтело скилла\n',
    );

    // Проект: `CLAUDE.md` лежит в корне репозитория, настройки — в `.claude/`.
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, 'CLAUDE.md'), `# Правила проекта\n\n${PROJECT_MARKER}\n`);
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(pnpm test:*)'] } }),
    );

    const store = new AppStore(appData);
    store.updateSettings({ claudeDirOverride: home });
    store.addProject({ id: PROJECT_ID, name: 'проект-переноса', path: project });

    app = Fastify();
    registerPortabilityRoutes(app, { store } as unknown as ServerContext);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(appData, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const passport = (query = '') =>
    app.inject({ method: 'GET', url: `/api/portability/passport${query}` });

  it('паспорт активного провайдера проходит собственную схему канона', async () => {
    const res = await passport();

    expect(res.statusCode).toBe(200);
    const parsed = agentEnvironmentSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.provider).toBe('claude');
    expect(parsed.success && parsed.data.scope).toBe('global');
    // Дом не пустой: инструкции, скилл, права и переменные в нём лежат живыми
    // файлами — паспорт без единой записи означал бы, что читался не этот дом.
    expect(parsed.success && parsed.data.items.length).toBeGreaterThan(0);
  });

  it('значение секрета не встречается нигде в теле ответа', async () => {
    const res = await passport();

    // Ключ найден и назван — иначе «маркера нет» значило бы лишь, что секрет не
    // прочитан вовсе, и проверка стала бы декорацией.
    const items = res.json<{ items: { kind: string; id: string }[] }>().items;
    expect(items.some((item) => item.kind === 'secret')).toBe(true);
    // Оба ключа названы секретами — иначе «маркера нет» держалось бы на одном
    // имени из двух, а второе ехало бы значением.
    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining(['secret:ANTHROPIC_API_KEY', 'secret:OPENAI_KEY']),
    );
    expect(res.body).not.toContain(SECRET_VALUE);
  });

  it('вид, которого в доме не оказалось, назван пустым, а не пропущен молчанием', async () => {
    const res = await passport();
    const body = res.json<{
      items: { kind: string }[];
      skipped: { kind: string; reason: string; detail: string }[];
    }>();

    // В этом доме есть инструкции, скилл, права и переменные — и НЕТ хуков, MCP,
    // команд, субагентов и плагинов. Экран рисует только непустые разделы, так
    // что вид без записи и без пропуска исчезает со страницы целиком, и человек
    // читает это как «панель сюда не смотрела».
    const spoken = new Set([...body.items, ...body.skipped].map((entry) => entry.kind));
    for (const kind of ['hook', 'mcpServer', 'command', 'subagent', 'plugin']) {
      expect(spoken.has(kind)).toBe(true);
    }
    for (const skip of body.skipped) expect(skip.detail).not.toBe('');
  });

  it('паспорт снимается и с другого установленного провайдера, а не только с активного', async () => {
    const res = await passport('?provider=codex');

    expect(res.statusCode).toBe(200);
    expect(res.json<{ provider: string }>().provider).toBe('codex');
  });

  it('пустая среда — это паспорт с названными причинами, а не ошибка', async () => {
    // Дом без единого файла: у Codex здесь нет ни AGENTS.md, ни config.toml.
    const empty = mkdtempSync(join(tmpdir(), 'cc-portability-empty-'));
    const previous = { home: process.env.HOME, profile: process.env.USERPROFILE };
    process.env.HOME = empty;
    process.env.USERPROFILE = empty;

    try {
      const res = await passport('?provider=codex');
      const body = res.json<{
        items: { intent: string; source: { file: string | null } }[];
        skipped: { reason: string; detail: string }[];
      }>();

      expect(res.statusCode).toBe(200);
      // «Пусто» обязано быть объяснено: пустой список без причин не отличим от
      // непрочитанного раздела, а это разные вещи для человека и для переноса.
      expect(body.skipped.length).toBeGreaterThan(0);
      for (const skip of body.skipped) expect(skip.detail).not.toBe('');
      // CLI на машине НЕ УСТАНОВЛЕН: ни одной записи. Паспорт отвечал здесь
      // режимом подтверждений «умолчание CLI, в файле ключа нет» и пропуском
      // `sandbox_mode = workspace-write` — описанная среда, которой не
      // существует (§7: «целевой CLI не установлен» — это «не проверено»).
      expect(body.items).toHaveLength(0);
      expect(body.skipped.some((skip) => skip.detail.includes('sandbox_mode'))).toBe(false);
      // И причина названа именно про файлы, которых нет.
      expect(body.skipped.some((skip) => skip.detail.includes('config.toml'))).toBe(true);
    } finally {
      if (previous.home === undefined) delete process.env.HOME;
      else process.env.HOME = previous.home;
      if (previous.profile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previous.profile;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('незнакомый провайдер — отказ с причиной, а не паспорт активного', async () => {
    const res = await passport('?provider=выдуманный');

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('unknown_provider');
  });

  it('уровень проекта без названного проекта отвергается, а не отдаётся домашним паспортом', async () => {
    const res = await passport('?scope=project');

    // Импортёры читают дом провайдера; ответить его содержимым с пометкой
    // «project» на каждой записи значило бы соврать о происхождении (П2.5).
    expect(res.statusCode).toBe(400);
    expect(res.json<{ messageCode: string }>().messageCode).toBe('portability-project-required');
  });

  it('незнакомый проект отвергается: корень уровня не приходит с провода', async () => {
    const res = await passport('?scope=project&project=никогда-не-заводили');

    // Корень берётся ТОЛЬКО из реестра панели. Принять путь из запроса значило бы
    // отдать чтение любого каталога машины тому, кто составил ссылку.
    expect(res.statusCode).toBe(400);
    expect(res.json<{ messageCode: string }>().messageCode).toBe('portability-project-unknown');
  });

  it('паспорт проекта читает файлы ПРОЕКТА, а дом остаётся не при чём', async () => {
    const res = await passport(`?scope=project&project=${PROJECT_ID}`);

    expect(res.statusCode).toBe(200);
    const parsed = agentEnvironmentSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.scope).toBe('project');

    const body = res.json<{ items: { intent: string; source: { file: string | null } }[] }>();
    // Маркер лежит в `CLAUDE.md` ПРОЕКТА, и одноимённый файл дома его не
    // содержит: паспорт, собранный домашними путями, прошёл бы схему и остался
    // бы зелёным — без этой строки проверка не умеет покраснеть.
    expect(JSON.stringify(body.items)).toContain(PROJECT_MARKER);
    for (const item of body.items) {
      if (item.source.file) expect(item.source.file.startsWith(home)).toBe(false);
    }
  });

  it('паспорт проекта снимается и с чужого CLI: уровень знают все десять', async () => {
    const res = await passport(`?provider=aider&scope=project&project=${PROJECT_ID}`);

    // Проектный уровень у чужих строится из `provider.projectConfig`, а не из
    // раскладки Claude: ответ обязан быть паспортом, а не отказом. Отказ по
    // незадокументированному уровню проверяется там, где он достижим, —
    // `domains/portability/project.test.ts`.
    expect(res.statusCode).toBe(200);
    expect(res.json<{ scope: string; provider: string }>()).toMatchObject({
      provider: 'aider',
      scope: 'project',
    });
  });

  it('чужой уровень отвергается, а не подменяется домашним', async () => {
    const res = await passport('?scope=весь-диск');

    expect(res.statusCode).toBe(400);
    expect(res.json<{ messageCode: string }>().messageCode).toBe('portability-scope-unknown');
  });

  /**
   * Отчёт верности на уровне маршрута (П1.2). Дом тот же живой, поэтому строки
   * отчёта выносятся о НАСТОЯЩИХ записях, а не о собранном руками наборе:
   * проверка, кормящая модуль своими данными, доказывает таблицу, а не систему.
   */
  describe('отчёт верности', () => {
    const fidelity = (query: string) =>
      app.inject({ method: 'GET', url: `/api/portability/fidelity${query}` });

    it('строка выносится о каждой записи паспорта, а сводка считается из строк', async () => {
      const passportRes = await passport();
      const items = passportRes.json<{ items: { id: string }[] }>().items;

      const res = await fidelity('?target=gemini');
      expect(res.statusCode).toBe(200);
      const { report } = res.json<{ report: FidelityReport }>();

      // Ни одна запись не исчезает по дороге: отчёт без строки читается как
      // «эта запись доедет», а молчаливая потеря — ровно то, что запрещено.
      expect(report.rows.map((row) => row.itemId).sort()).toEqual(items.map((i) => i.id).sort());
      expect(report.source).toBe('claude');
      expect(report.target).toBe('gemini');
      // Сводка = пересчёт строк, а не второй счётчик: разошедшись, он показал бы
      // человеку «3 нативно» над двумя нативными строками.
      expect(report.summary).toEqual(summarizeFidelity(report.rows));
      const total = Object.values(report.summary).reduce((sum, count) => sum + count, 0);
      expect(total).toBe(report.rows.length);
      for (const row of report.rows) {
        expect(fidelityReasons).toContain(row.reason);
        expect(row.intent).not.toBe('');
      }
    });

    it('«работает только при запуске через панель» считается из строк и бывает не нулём', async () => {
      const counted = new Map<string, number>();
      for (const target of ['gemini', 'qwen', 'codex', 'opencode']) {
        const { report } = (await fidelity(`?target=${target}`)).json<{ report: FidelityReport }>();
        expect(report.onlyThroughPanel).toBe(countOnlyThroughPanel(report.rows));
        counted.set(target, report.onlyThroughPanel);
      }

      // Хотя бы у одной цели строка ненулевая — иначе равенство выше держалось
      // бы на двух нулях и не доказывало ничего (проверка, которая не может
      // покраснеть, — украшение).
      expect([...counted.values()].some((count) => count > 0)).toBe(true);
    });

    /** Оттиск из `state.json` вместе с временем последней записи файла. */
    const storedMark = (key: string) => {
      const path = join(appData, 'state.json');
      const state = JSON.parse(readFileSync(path, 'utf8')) as {
        portabilityFidelity?: Record<string, Record<string, unknown>>;
      };
      return { mark: state.portabilityFidelity?.[key], raw: readFileSync(path, 'utf8') };
    };

    it('в state.json ложится ОТТИСК без строк, а прошлый расчёт возвращается отдельно', async () => {
      const first = (await fidelity('?target=qwen')).json<{
        report: FidelityReport;
        previous: unknown;
      }>();
      // Первого расчёта прошлым не бывает: сравнивать не с чем.
      expect(first.previous).toBeNull();

      const key = 'claude->qwen:global';
      const { mark } = storedMark(key);
      expect(mark).toBeDefined();
      expect(mark?.computedAt).toBe(first.report.computedAt);
      expect(mark?.canonVersion).toBe(first.report.canonVersion);
      // СТРОК В СОСТОЯНИИ НЕТ. Отчёт по живому дому — десятки килобайт, а пар
      // «источник → цель» под две сотни: хранение строк раздувало `state.json`
      // на каждом открытии страницы ради того, что и так считается заново.
      expect(Object.keys(mark ?? {}).sort()).toEqual([
        'canonVersion',
        'computedAt',
        'onlyThroughPanel',
        'summary',
      ]);
      expect(first.report.rows.length).toBeGreaterThan(0);

      const second = (await fidelity('?target=qwen')).json<{
        report: FidelityReport;
        previous: { computedAt: string; readable: boolean };
      }>();
      // Отчёт считается ЗАНОВО, а сохранённый отвечает на другой вопрос — что
      // панель обещала в прошлый раз и тем ли словарём это считано.
      expect(second.previous.computedAt).toBe(first.report.computedAt);
      expect(second.previous.readable).toBe(true);
    });

    it('оттиск переписывается только при СМЕНЕ обещания, а не на каждом запросе', async () => {
      const key = 'claude->codex:global';
      const first = (await fidelity('?target=codex')).json<{ report: FidelityReport }>();
      const after = storedMark(key);

      // Три запроса подряд по тому же дому дают то же обещание — и не трогают
      // файл. Пока оттиск переписывался каждым запросом, «прошлый раз» означал
      // «секунду назад»: одно обновление страницы затирало базу сравнения, и
      // строка «в прошлый раз обещали другое» не могла появиться в принципе.
      for (let attempt = 0; attempt < 3; attempt += 1) await fidelity('?target=codex');
      expect(storedMark(key).raw).toBe(after.raw);
      expect(storedMark(key).mark?.computedAt).toBe(first.report.computedAt);

      // А изменившаяся среда обещание меняет — и запись происходит. Новый скилл
      // в доме добавляет запись паспорта, значит и строку отчёта.
      mkdirSync(join(home, 'skills', 'второй'), { recursive: true });
      writeFileSync(
        join(home, 'skills', 'второй', 'SKILL.md'),
        '---\nname: второй\ndescription: ещё один скилл\n---\n\nтело\n',
      );

      const changed = (await fidelity('?target=codex')).json<{
        report: FidelityReport;
        previous: { computedAt: string };
      }>();
      expect(changed.report.rows.length).toBe(first.report.rows.length + 1);
      // Сравнение идёт с тем, что лежало ДО расчёта: человек видит прошлое
      // обещание, а не только что записанное.
      expect(changed.previous.computedAt).toBe(first.report.computedAt);
      expect(storedMark(key).mark?.computedAt).toBe(changed.report.computedAt);
    });

    it('цель не названа или незнакома — отказ с причиной, а не отчёт о самом себе', async () => {
      for (const query of ['', '?target=', '?target=выдуманный']) {
        const res = await fidelity(query);
        expect(res.statusCode).toBe(400);
        expect(res.json<{ messageCode: string }>().messageCode).toBe('portability-target-unknown');
      }
    });

    it('испорченный settings.json — названный отказ на ОБОИХ маршрутах, а не 500', async () => {
      // Ровно та поломка, которую человек делает руками: лишняя запятая. До
      // починки `readJsonFile` бросал из импортёра, и панель отвечала
      // пятисоткой с текстом разборщика — а тот ЦИТИРУЕТ начало файла, рядом с
      // которым в `settings.json` живут ключи API.
      writeFileSync(join(home, 'settings.json'), '{ "env": { "EDITOR": "code", } }');

      for (const res of [await passport(), await fidelity('?target=codex')]) {
        expect(res.statusCode).toBe(400);
        expect(res.json<{ messageCode: string }>().messageCode).toBe(
          'portability-source-not-readable',
        );
        // Наружу идёт код, а не цитата файла: иначе отказ сам выносил бы то,
        // что паспорт бережно не показывает.
        expect(res.body).not.toContain('EDITOR');
      }
    });

    it('значение секрета не встречается нигде в отчёте', async () => {
      const res = await fidelity('?target=codex');

      // Секрет в паспорте ЕСТЬ (проверено выше), и строка о нём в отчёте тоже —
      // иначе «маркера нет» значило бы лишь, что о секрете никто не говорил.
      const { report } = res.json<{ report: FidelityReport }>();
      expect(report.rows.some((row) => row.kind === 'secret')).toBe(true);
      expect(res.body).not.toContain(SECRET_VALUE);
    });
  });
});
