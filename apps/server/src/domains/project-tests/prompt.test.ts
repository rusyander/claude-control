import type { ProjectTestGroup } from '@agentdeck/contracts';
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

  it('автоматизация пишет тесты в идиоме проекта и не заводит новый фреймворк', () => {
    const prompt = buildPrompt([group], { projectPath: '/p', mode: 'automate' });

    expect(prompt).toContain('Новый фреймворк не заводи');
    expect(prompt).toContain('automation');
    // Ровно здесь единственное исключение из «трогать только .agent/tests».
    expect(prompt).toContain('ФАЙЛЫ ТЕСТОВ');
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
});
