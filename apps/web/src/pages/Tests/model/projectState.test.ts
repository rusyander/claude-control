import { describe, it, expect } from 'vitest';
import { askedProjectMissing, askedProjectPending, testsProjectState } from './projectState';

/**
 * Что показывает раздел тестов, пока нет выбранного проекта.
 *
 * «В реестре ещё нет проектов» — совет добавить проект; при упавшей загрузке
 * реестра он врёт: проекты есть, их не удалось прочитать, и добавлять второй
 * раз нечего. Ошибка и пустота — разные экраны.
 */
describe('testsProjectState', () => {
  it('грузится — скелет, а не пустота', () => {
    expect(testsProjectState({ isLoading: true, isError: false, count: 0 })).toBe('loading');
  });

  it('реестр не загрузился и знать нечего — ошибка с повтором, а не «проектов нет»', () => {
    expect(testsProjectState({ isLoading: false, isError: true, count: 0 })).toBe('error');
  });

  it('реестр пуст по-настоящему — пустое состояние', () => {
    expect(testsProjectState({ isLoading: false, isError: false, count: 0 })).toBe('empty');
  });

  it('реестр упал, но открытые вкладки проектов есть — работать можно', () => {
    expect(testsProjectState({ isLoading: false, isError: true, count: 2 })).toBe('ready');
  });
});

/**
 * Агент панели открывает раздел ссылкой `?project=<каталог>`. Каталог, которого
 * панель не знает, молча подменялся другим проектом — человек смотрел не на те
 * тесты и не знал об этом.
 */
describe('askedProjectMissing', () => {
  const projects = [{ path: 'C:/work/app' }];

  it('неизвестный каталог — называется', () => {
    expect(askedProjectMissing(projects, 'D:/nope', { isLoading: false, isError: false })).toBe(
      true,
    );
  });

  it('известный каталог в другом написании — найден', () => {
    expect(
      askedProjectMissing(projects, 'c:\\work\\app\\', { isLoading: false, isError: false }),
    ).toBe(false);
  });

  it('пока реестр грузится или упал — судить не по чему', () => {
    expect(askedProjectMissing(projects, 'D:/nope', { isLoading: true, isError: false })).toBe(
      false,
    );
    expect(askedProjectMissing(projects, 'D:/nope', { isLoading: false, isError: true })).toBe(
      false,
    );
  });

  it('каталог не назван — и искать нечего', () => {
    expect(askedProjectMissing(projects, undefined, { isLoading: false, isError: false })).toBe(
      false,
    );
  });
});

/**
 * Реестр упал, открытые вкладки есть: каталог из ссылки ни найден, ни назван
 * пропавшим, и раздел молча показывал другой проект (F-303). Такое «ещё не
 * решено» теперь видно отдельной строкой.
 */
describe('askedProjectPending', () => {
  const projects = [{ path: 'C:/work/app' }];

  it('реестр упал, каталога среди вкладок нет — ждёт решения', () => {
    expect(askedProjectPending(projects, 'D:/other', { isLoading: false, isError: true })).toBe(
      true,
    );
  });

  it('каталог среди вкладок есть — решено и при упавшем реестре', () => {
    expect(
      askedProjectPending(projects, 'c:\\work\\app', { isLoading: false, isError: true }),
    ).toBe(false);
  });

  it('реестр загружен или каталог не назван — ждать нечего', () => {
    expect(askedProjectPending(projects, 'D:/other', { isLoading: false, isError: false })).toBe(
      false,
    );
    expect(askedProjectPending(projects, undefined, { isLoading: false, isError: true })).toBe(
      false,
    );
  });
});
