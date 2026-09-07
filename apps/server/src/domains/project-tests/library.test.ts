import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultEnvironment,
  readEnvironments,
  readSchema,
  readSharedSteps,
  readViews,
  removeEnvironment,
  removeSharedStep,
  saveEnvironment,
  saveSchema,
  saveSharedStep,
  saveView,
} from './library.ts';
import { ProjectTestsNotFoundError } from './files.ts';

/**
 * Обвязка библиотеки: общие шаги, окружения, свои поля и статусы, виды.
 *
 * Проверяется то, что ломается молча: идентификатор из русского названия (без
 * запасного слова файл оказался бы безымянным), единственность окружения по
 * умолчанию и щадящее чтение — сломанный файл не должен гасить весь раздел.
 */
describe('project-tests/library', () => {
  let project = '';
  const now = '2026-09-07T10:00:00.000Z';

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-library-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('общий шаг получает идентификатор из русского названия и переживает чтение', () => {
    const saved = saveSharedStep(
      project,
      { title: 'Войти под тестовым пользователем', steps: ['открыть вход', 'ввести логин'] },
      now,
    );

    expect(saved.id).toBeTruthy();
    expect(saved.steps).toHaveLength(2);
    expect(readSharedSteps(project)).toHaveLength(1);
  });

  it('второй шаг с тем же названием не затирает первый', () => {
    const first = saveSharedStep(project, { title: 'Вход', steps: ['шаг'] }, now);
    const second = saveSharedStep(project, { title: 'Вход', steps: ['шаг'] }, now);

    expect(second.id).not.toBe(first.id);
    expect(readSharedSteps(project)).toHaveLength(2);
  });

  it('шаг без шагов не сохраняется — иначе кейс сослался бы на пустоту', () => {
    expect(() => saveSharedStep(project, { title: 'Пустой', steps: [] }, now)).toThrow();
  });

  it('удаление несуществующего общего шага — 404, а не молчаливое ок', () => {
    expect(() => removeSharedStep(project, 'нет-такого')).toThrow(ProjectTestsNotFoundError);
  });

  it('окружение по умолчанию всегда одно', () => {
    saveEnvironment(project, { title: 'Локальное', isDefault: true });
    saveEnvironment(project, { title: 'Прод', isDefault: true });

    const environments = readEnvironments(project);
    expect(environments.filter((item) => item.isDefault)).toHaveLength(1);
    expect(defaultEnvironment(environments)?.title).toBe('Прод');
  });

  it('удалённое окружение исчезает из списка', () => {
    const saved = saveEnvironment(project, { title: 'Временное' });
    removeEnvironment(project, saved.id);

    expect(readEnvironments(project)).toEqual([]);
  });

  // Своих статусов у проекта по умолчанию нет: каноническая пятёрка живёт в
  // контрактах, а этот файл — только то, что человек добавил сверх неё.
  it('схема без файла — пустая, а не ошибка', () => {
    expect(readSchema(project)).toEqual({ attributes: [], statuses: [] });
  });

  it('своё поле и свой статус переживают запись и чтение', () => {
    saveSchema(project, {
      attributes: [{ key: 'stand', title: 'Стенд', type: 'select', options: ['dev', 'prod'] }],
      statuses: [{ id: 'retest', title: 'Перепроверить', group: 'failed' }],
    });

    const schema = readSchema(project);
    expect(schema.attributes[0]?.title).toBe('Стенд');
    expect(schema.statuses.some((item) => item.id === 'retest')).toBe(true);
  });

  it('сохранённый вид пишется и читается фильтром целиком', () => {
    saveView(project, { title: 'Только дым', filter: { tags: ['smoke'] } }, now);

    const views = readViews(project);
    expect(views[0]?.filter.tags).toEqual(['smoke']);
  });

  it('сломанный файл окружений не гасит раздел', () => {
    mkdirSync(join(project, '.agent', 'tests'), { recursive: true });
    writeFileSync(join(project, '.agent', 'tests', 'environments.json'), '{ сломано');

    expect(readEnvironments(project)).toEqual([]);
    // Файл человека не переписывается молча: чинить его — его решение.
    expect(readFileSync(join(project, '.agent', 'tests', 'environments.json'), 'utf8')).toBe(
      '{ сломано',
    );
  });
});
