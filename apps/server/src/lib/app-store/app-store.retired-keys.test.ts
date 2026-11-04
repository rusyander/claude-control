import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from './app-store.ts';

/**
 * Заметки главным чатам (`chatEscalations`) ушли вместе с маршрутами чата групп
 * (этап 10). `state.json`, записанный прежней версией, обязан читаться как
 * раньше: остальное на месте, прежний ключ снят и первой записью не повторён.
 */
describe('AppStore: прежний ключ в state.json', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-retired-keys-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('chatEscalations из старого файла не мешает чтению и не переживает запись', () => {
    const appData = join(dir, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const file = join(appData, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        chatGroupSettings: { s1: { autonomous: false } },
        chatKeyAliases: { 'new-1': 's1' },
        chatEscalations: { s1: [{ id: 'kid:1', childChatId: 'kid', text: 't', read: false }] },
      }),
    );

    const store = new AppStore(appData);
    expect(store.getChatGroupSettings('new-1')).toEqual({ autonomous: false });

    store.setCodeView('C:/work/project', {
      file: 'a.ts',
      openDirs: [],
      showDiff: false,
      onlyChanged: false,
    });
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty('chatEscalations');
    expect(onDisk.chatGroupSettings).toEqual({ s1: { autonomous: false } });
    expect(onDisk.chatKeyAliases).toEqual({ 'new-1': 's1' });
  });

  /**
   * Проектное правило «Ревью после работы» снято вместе с тумблером в меню чата
   * (этап 10, G14). Файл, где человек выключал ревью, читается, прежний ключ
   * первой записью не повторён.
   */
  it('projectReviewAfterWork из старого файла не мешает чтению и не переживает запись', () => {
    const appData = join(dir, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const file = join(appData, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        projectReviewAfterWork: { 'c:/work/project': false },
      }),
    );

    const store = new AppStore(appData);

    store.setCodeView('C:/work/project', {
      file: 'a.ts',
      openDirs: [],
      showDiff: false,
      onlyChanged: false,
    });
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty('projectReviewAfterWork');
    expect(onDisk.projectCodeViews).toBeDefined();
  });

  /**
   * Тумблер «Подбирать модель под задачу» снят (этап 10, G14): подбор по роду
   * работы шёл только в предложение разделения, а разделение из чата снято.
   * Файл, где человек выключал подбор, читается: соседние ключи на месте,
   * прежний ключ первой записью не повторён.
   */
  it('projectCascade из старого файла не мешает чтению и не переживает запись', () => {
    const appData = join(dir, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const file = join(appData, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        chatKeyAliases: { 'new-1': 's1' },
        projectCascade: { 'c:/work/project': false },
      }),
    );

    const store = new AppStore(appData);
    store.setCodeView('C:/work/project', {
      file: 'a.ts',
      openDirs: [],
      showDiff: false,
      onlyChanged: false,
    });
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty('projectCascade');
    expect(onDisk.chatKeyAliases).toEqual({ 'new-1': 's1' });
  });

  /**
   * Тумблер «Предлагать разделить задачи по чатам» снят (этап 10, G14): у карточки
   * разделения нет кнопок, просить агента о предложении незачем. Настройки, где
   * человек его выключал, читаются: соседние поля на месте, прежнее поле не видно
   * панели и первой записью не повторено.
   */
  it('settings.taskSplitInitiative из старого файла не мешает чтению и не переживает запись', () => {
    const appData = join(dir, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const file = join(appData, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({ settings: { taskSplitInitiative: false, handoffInitiative: false } }),
    );

    const store = new AppStore(appData);
    expect(store.getSettings()).not.toHaveProperty('taskSplitInitiative');
    expect(store.getSettings().handoffInitiative).toBe(false);
    store.setCodeView('C:/work/project', {
      file: 'a.ts',
      openDirs: [],
      showDiff: false,
      onlyChanged: false,
    });
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { settings?: Record<string, unknown> };
    expect(onDisk.settings ?? {}).not.toHaveProperty('taskSplitInitiative');
    expect(onDisk.settings?.handoffInitiative).toBe(false);
  });
});
