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
      expect(prompt).toContain('не повод чинить');
      expect(prompt).toContain('не коммить');
    }
  });

  it('генерация требует приёмов тест-дизайна, а не счастливых путей', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'generate' });

    expect(prompt).toContain('классы эквивалентности');
    expect(prompt).toContain('границы');
    expect(prompt).toContain('Негативные проверки'.toLowerCase());
    expect(prompt).toContain('приоритет по риску');
    expect(prompt).toContain('codePaths');
  });

  it('прогон велит писать результат после КАЖДОГО кейса и различать blocked/skipped', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'run' });

    expect(prompt).toContain('после КАЖДОГО кейса');
    expect(prompt).toContain('blocked');
    expect(prompt).toContain('skipped');
    expect(prompt).toContain('Отправка сообщения');
    expect(prompt).toContain('оракул');
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
    expect(prompt).toContain('переменных окружения');
    // Значений у задания нет физически: их знает только процесс прогона.
    expect(prompt).not.toContain('Пароль');
  });

  it('автоматизация пишет тесты в идиоме проекта и не заводит новый фреймворк', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'automate' });

    expect(prompt).toContain('Новый фреймворк не заводи');
    expect(prompt).toContain('automation');
    // Ровно здесь единственное исключение из «трогать только .agent/tests».
    expect(prompt).toContain('ФАЙЛЫ ТЕСТОВ');
  });

  it('автоматизация обязана оставить кейсу ключ, по которому сойдётся импорт из CI', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'automate' });

    // Из CI приезжает одно имя теста: без метки и `externalId` результат уедет
    // в «нераспознанные», и автоматизация окажется работой впустую.
    expect(prompt).toContain('externalId');
    expect(prompt).toContain('[gui-001]');
    expect(prompt).toContain('нераспознанные');
  });

  it('исследование ограничено хартией и туры перечислены', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'explore', scope: 'вложения' });

    expect(prompt).toContain('Хартия сессии: вложения');
    expect(prompt).toContain('тур «плохой ввод»');
  });

  it('задание предупреждает, что границы держит панель, а спрашивать некого', () => {
    // Права теперь проверяет код (`run-permissions.ts`), но слова остаются:
    // правило, о котором модель знает, она соблюдает сама, а отказ посреди
    // работы стоит ей целого хода и выглядит как поломка инструмента.
    for (const mode of ['generate', 'run', 'explore', 'automate'] as const) {
      const prompt = buildPrompt([group], { projectPath: '/p', mode });
      expect(prompt).toContain('панель отклоняет');
      expect(prompt).toContain('Спрашивать разрешение');
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

    expect(prompt).toContain('ТРЕБОВАНИЕ QA-42');
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

    expect(prompt).toContain('ИЗМЕНЕНИЯ origin/main..HEAD');
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

    expect(prompt).toContain('ПРОВАЛ кейса gui/gui-001');
    expect(prompt).toContain('сообщение пропало после перезагрузки');
    expect(prompt).toContain('ОДИН регрессионный кейс');
    expect(prompt).toContain('Исходный кейс не трогай');
    expect(prompt).toContain('"регресс"');
  });

  it('без материала задание остаётся обычной генерацией по коду', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'generate' });
    expect(prompt).not.toContain('Источник —');
    expect(prompt).toContain('"source": "code"');
  });
});
