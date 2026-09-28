import type {
  ProjectTestGenerateMaterial,
  ProjectTestGenerateSource,
  ProjectTestGroup,
} from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { buildPrompt, runName } from './prompt.ts';

/**
 * Задание агенту.
 *
 * Прогон идёт без человека за спиной, поэтому в тексте есть два места, которые
 * нельзя потерять при правках: ГРАНИЦЫ (что трогать нельзя) и требование писать
 * результат после каждого кейса. Первое удерживает агента от «а заодно починю»,
 * второе — от получаса пустого экрана и потери всего при обрыве.
 */
describe('project-tests/prompt', () => {
  const group: ProjectTestGroup = {
    id: 'gui',
    title: 'GUI',
    file: '.agent/tests/gui.tests.json',
    cases: [
      {
        id: 'gui-001',
        type: 'case',
        title: 'Отправка сообщения',
        steps: [{ action: 'нажать «Отправить»', expected: 'сообщение в ленте' }],
        expected: 'сообщение отправлено',
        oracle: 'сообщение видно в ленте',
        status: 'unknown',
        source: 'agent',
      },
    ],
  };

  it('в любом режиме запрещено чинить код и коммитить', () => {
    for (const mode of ['generate', 'run', 'explore'] as const) {
      const prompt = buildPrompt([group], { projectPath: '/p', mode });
      expect(prompt).toContain('.agent/tests');
      expect(prompt).toContain('not a reason to fix it');
      expect(prompt).toContain('commit nothing');
    }
  });

  it('генерация требует приёмов тест-дизайна, а не счастливых путей', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'generate' });

    expect(prompt).toContain('equivalence classes');
    expect(prompt).toContain('boundaries');
    expect(prompt).toContain('negative checks');
    expect(prompt).toContain('priority by risk');
    expect(prompt).toContain('codePaths');
  });

  it('прогон велит писать результат после КАЖДОГО кейса и различать blocked/skipped', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'run' });

    expect(prompt).toContain('after EACH case');
    expect(prompt).toContain('blocked');
    expect(prompt).toContain('skipped');
    expect(prompt).toContain('Отправка сообщения');
    expect(prompt).toContain('oracle:');
  });

  it('недостающую проверку прогон кладёт в черновик, а не в файл группы', () => {
    const prompt = buildPrompt(
      [group],
      { projectPath: '/p', mode: 'run' },
      { shared: [], draftFile: '.agent/tests/drafts/run-7.draft.json' },
    );

    // Библиотеку меняет человек через приёмку: прогон предлагает, не записывает.
    expect(prompt).toContain('do NOT write it into the group file');
    expect(prompt).toContain('.agent/tests/drafts/run-7.draft.json');
    expect(prompt).toContain('"source":"run"');
    expect(prompt).not.toContain('add a new case with `status: "unknown"`');

    // Без имени файла (старый вызов) подсказка всё равно ведёт в папку черновиков.
    const bare = buildPrompt([group], { projectPath: '/p', mode: 'run' });
    expect(bare).toContain('.agent/tests/drafts/<runId>.draft.json');
  });

  it('прогон по отобранным кейсам не тащит в задание остальные', () => {
    const two: ProjectTestGroup = {
      ...group,
      cases: [group.cases[0]!, { ...group.cases[0]!, id: 'gui-002', title: 'Загрузка файла' }],
    };

    const prompt = buildPrompt([two], { projectPath: '/p', mode: 'run', caseIds: ['gui-001'] });

    expect(prompt).toContain('Отправка сообщения');
    expect(prompt).not.toContain('Загрузка файла');
  });

  it('задетые правками кейсы попадают в начало задания с причиной', () => {
    const prompt = buildPrompt(
      [group],
      { projectPath: '/p', mode: 'run', changedOnly: true },
      {
        shared: [],
        impact: [{ caseId: 'gui-001', title: 'Отправка сообщения', reason: 'изменён src/Chat' }],
      },
    );

    expect(prompt).toContain('изменён src/Chat');
  });

  it('окружение прогона попадает в задание — иначе агент поднимет не то', () => {
    const prompt = buildPrompt(
      [group],
      { projectPath: '/p', mode: 'run' },
      {
        shared: [],
        environment: {
          id: 'local',
          title: 'Локальное',
          baseUrl: 'http://127.0.0.1:8888',
          start: 'pnpm dev',
        },
      },
    );

    expect(prompt).toContain('http://127.0.0.1:8888');
    expect(prompt).toContain('pnpm dev');
  });

  it('доступы стенда названы ИМЕНАМИ переменных: значения в задание не уезжают', () => {
    const prompt = buildPrompt(
      [group],
      { projectPath: '/p', mode: 'run' },
      {
        shared: [],
        environment: {
          id: 'stand',
          title: 'Стенд',
          baseUrl: 'https://stand.example',
          secrets: [{ name: 'STAND_LOGIN' }, { name: 'STAND_PASSWORD', title: 'Пароль' }],
        },
      },
    );

    expect(prompt).toContain('STAND_LOGIN, STAND_PASSWORD');
    expect(prompt).toContain('environment variables');
    // Значений у задания нет физически: их знает только процесс прогона.
    expect(prompt).not.toContain('Пароль');
  });

  it('автоматизация пишет тесты в идиоме проекта и не заводит новый фреймворк', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'automate' });

    expect(prompt).toContain('Do not introduce a new framework');
    expect(prompt).toContain('automation');
    // Ровно здесь единственное исключение из «трогать только .agent/tests».
    expect(prompt).toContain('TEST FILES');
  });

  it('автоматизация обязана оставить кейсу ключ, по которому сойдётся импорт из CI', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'automate' });

    // Из CI приезжает одно имя теста: без метки и `externalId` результат уедет
    // в «нераспознанные», и автоматизация окажется работой впустую.
    expect(prompt).toContain('externalId');
    expect(prompt).toContain('[gui-001]');
    expect(prompt).toContain('unrecognised');
  });

  it('пустое пожелание при выбранной группе — тема группы, а не всё приложение в неё', () => {
    // Кнопка в разделе всегда шлёт выбранную группу: «покрывай приложение целиком»
    // сваливало весь проект в одну группу, какой бы узкой она ни была.
    const scoped = buildPrompt([{ ...group, description: 'Отправка из поля ввода' }], {
      projectPath: '/p',
      mode: 'generate',
      groupId: 'gui',
    });
    expect(scoped).toContain('No wishes — cover the topic of the group "GUI"');
    expect(scoped).toContain('the group "GUI" (Отправка из поля ввода)');
    expect(scoped).not.toContain('cover the whole application');

    const whole = buildPrompt([group], { projectPath: '/p', mode: 'generate' });
    expect(whole).toContain('cover the whole application');
  });

  it('исследование ограничено хартией и туры перечислены', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'explore', scope: 'вложения' });

    expect(prompt).toContain('Session charter: вложения');
    expect(prompt).toContain('the "bad input" tour');
  });

  it('находка исследования записана так, чтобы её можно было воспроизвести и отличить', () => {
    const prompt = buildPrompt([group], {
      projectPath: '/p',
      mode: 'explore',
      scope: 'вложения',
      groupId: 'gui',
    });

    // Без разбора провала находку не воспроизвести, без UTC история путает часы,
    // а без source её не отличить от кейса, написанного человеком.
    expect(prompt).toContain('`failure`');
    expect(prompt).toContain('date -u +%FT%TZ');
    expect(prompt).toContain('Do not fill in `lastRunId`');
    expect(prompt).toContain('"source": "agent"');
    expect(prompt).toContain('do not change the status of existing cases');
    expect(prompt).toContain('only into the group "gui"');
    expect(prompt).toContain('.agent/tests/attachments/');
  });

  it('задание предупреждает, что границы держит панель, а спрашивать некого', () => {
    // Права теперь проверяет код (`run-permissions.ts`), но слова остаются:
    // правило, о котором модель знает, она соблюдает сама, а отказ посреди
    // работы стоит ей целого хода и выглядит как поломка инструмента.
    for (const mode of ['generate', 'run', 'explore', 'automate'] as const) {
      const prompt = buildPrompt([group], { projectPath: '/p', mode });
      expect(prompt).toContain('the panel refuses');
      expect(prompt).toContain('There is nobody to ask for');
      expect(prompt).toContain('note');
    }
  });

  it('имя сессии называет режим и место — по нему прогон находят в списке чатов', () => {
    expect(runName({ projectPath: '/p', mode: 'run', groupId: 'gui' }, [group])).toContain('GUI');
    expect(runName({ projectPath: '/p', mode: 'generate' }, [group])).toContain('генерация');
    expect(runName({ projectPath: '/p', mode: 'automate' }, [group])).toContain('автоматизация');
  });

  it('имя генерации называет источник: три подряд иначе неразличимы в списке', () => {
    const base = { projectPath: '/p', mode: 'generate' } as const;
    expect(runName({ ...base, source: 'requirement', sourceRef: 'QA-42' }, [group])).toContain(
      'QA-42',
    );
    expect(runName({ ...base, source: 'diff' }, [group])).toContain('диффу');
    expect(
      runName({ ...base, source: 'defect', sourceCase: { groupId: 'gui', caseId: 'gui-001' } }, [
        group,
      ]),
    ).toContain('gui-001');
  });
});

/**
 * Источник генерации.
 *
 * Проверяется одно и то же для всех трёх: материал, собранный панелью, дошёл до
 * задания ЦЕЛИКОМ и вместе с требованием к результату — ссылкой на требование,
 * `codePaths`, меткой регресса. Без этой половины «покрыть требование»
 * неотличимо от обычной генерации, а строка матрицы остаётся непокрытой.
 */
describe('project-tests/prompt: источник генерации', () => {
  const group: ProjectTestGroup = { id: 'gui', title: 'GUI', file: 'f', cases: [] };
  const build = (material: ProjectTestGenerateMaterial, source: ProjectTestGenerateSource) =>
    buildPrompt([group], { projectPath: '/p', mode: 'generate', source }, { shared: [], material });

  it('требование доходит текстом задачи и обязывает поставить ссылку в links', () => {
    const prompt = build(
      {
        source: 'requirement',
        requirement: {
          key: 'QA-42',
          url: 'https://acme.atlassian.net/browse/QA-42',
          title: 'Вход по ссылке',
          description: 'Ссылка живёт 15 минут.',
        },
      },
      'requirement',
    );

    expect(prompt).toContain('REQUIREMENT QA-42');
    expect(prompt).toContain('Ссылка живёт 15 минут.');
    expect(prompt).toContain('"type": "requirement"');
    expect(prompt).toContain('https://acme.atlassian.net/browse/QA-42');
    // Черновик помечается источником: по нему потом видно, откуда кейс взялся.
    expect(prompt).toContain('"source": "requirement"');
  });

  it('дифф даёт список путей и требует проставить их в codePaths', () => {
    const prompt = build(
      {
        source: 'diff',
        diff: { range: 'origin/main..HEAD', files: ['src/Chat/Send.tsx'], summary: '3 files' },
      },
      'diff',
    );

    expect(prompt).toContain('CHANGES origin/main..HEAD');
    expect(prompt).toContain('- src/Chat/Send.tsx');
    expect(prompt).toContain('codePaths');
  });

  it('провал просит ОДИН регрессионный кейс и запрещает трогать исходный', () => {
    const prompt = build(
      {
        source: 'defect',
        defect: {
          groupId: 'gui',
          caseId: 'gui-001',
          title: 'Отправка сообщения',
          steps: ['нажать «Отправить» → сообщение в ленте'],
          note: 'сообщение пропало после перезагрузки',
          attachments: ['shot.png'],
          url: 'https://acme.atlassian.net/browse/QA-77',
        },
      },
      'defect',
    );

    expect(prompt).toContain('FAILURE of the case gui/gui-001');
    expect(prompt).toContain('сообщение пропало после перезагрузки');
    expect(prompt).toContain('ONE regression case');
    expect(prompt).toContain('Do not touch the original case');
    // Метка регресса — на языке библиотеки: русский кейс получает «регресс»,
    // иначе он не попадёт в планы и наборы, отобранные по этой метке.
    expect(prompt).toContain('tags: ["регресс"]');
  });

  it('метка регресса: английская библиотека — regression, уже принятая метка библиотеки — она', () => {
    const defect = (title: string) => ({
      source: 'defect' as const,
      defect: { groupId: 'gui', caseId: 'gui-001', title, steps: [], attachments: [] },
    });
    expect(build(defect('Send a message'), 'defect')).toContain('tags: ["regression"]');
    const tagged: ProjectTestGroup = {
      ...group,
      cases: [
        {
          id: 'gui-009',
          title: 'Старый регресс',
          tags: ['regression'],
          steps: [],
        } as unknown as ProjectTestGroup['cases'][number],
      ],
    };
    const prompt = buildPrompt(
      [tagged],
      { projectPath: '/p', mode: 'generate', source: 'defect' },
      { shared: [], material: defect('Отправка сообщения') },
    );
    expect(prompt).toContain('tags: ["regression"]');
  });

  it('без материала задание остаётся обычной генерацией по коду', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'generate' });
    expect(prompt).not.toContain('Source —');
    expect(prompt).toContain('"source": "code"');
  });
});
