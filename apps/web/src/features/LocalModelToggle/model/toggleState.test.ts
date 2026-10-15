import { describe, expect, it } from 'vitest';
import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';
import { localToggleState } from './toggleState';

/**
 * Что кнопке локальной модели делать по снимку раздела. Снимок — та же форма, что
 * отдаёт сервер; здесь меняются только поля, по которым кнопка решает.
 */

const TAG = 'qwen3.8:27b';

function info(over: {
  runtime?: 'panel' | 'system' | 'none';
  installed?: string[];
  connect?: Partial<LocalModelsInfo['connect']>;
  server?: Partial<LocalModelsInfo['server']>;
}): LocalModelsInfo {
  return {
    runtime: { source: over.runtime ?? 'panel' },
    installed: (over.installed ?? [TAG]).map((tag) => ({ tag })),
    catalog: { models: [{ tag: TAG, title: 'Qwen3.8 27B' }] },
    connect: { configured: true, active: false, model: TAG, ...over.connect },
    server: { running: false, ...over.server },
  } as unknown as LocalModelsInfo;
}

describe('localToggleState', () => {
  it('снимка ещё нет — кнопки нет', () => {
    expect(localToggleState(undefined)).toEqual({ kind: 'unknown' });
  });

  it('причины по порядку шагов: сервер моделей, модель, выбор для агентов', () => {
    expect(localToggleState(info({ runtime: 'none' }))).toMatchObject({ reason: 'runtime' });
    expect(localToggleState(info({ installed: [] }))).toMatchObject({ reason: 'models' });
    expect(localToggleState(info({ connect: { configured: false, model: '' } }))).toMatchObject({
      kind: 'blocked',
      reason: 'agents',
      installed: [{ tag: TAG, title: 'Qwen3.8 27B' }],
    });
    // Контур смотрит на модель, которую удалили: включать нечего, но скачанные — на выбор.
    expect(
      localToggleState(info({ installed: ['qwen3.5:9b'], connect: { model: TAG } })),
    ).toMatchObject({ reason: 'agents', installed: [{ tag: 'qwen3.5:9b', title: 'qwen3.5:9b' }] });
  });

  it('готово: выключено, включено и загружается, включено и готово', () => {
    expect(localToggleState(info({}))).toEqual({
      kind: 'ready',
      model: TAG,
      title: 'Qwen3.8 27B',
      active: false,
      starting: false,
    });
    expect(localToggleState(info({ connect: { active: true } }))).toMatchObject({
      active: true,
      starting: true,
    });
    // Сервер поднят другой моделью — эта ещё не готова.
    expect(
      localToggleState(
        info({ connect: { active: true }, server: { running: true, model: 'qwen3.5:9b' } }),
      ),
    ).toMatchObject({ starting: true });
    expect(
      localToggleState(info({ connect: { active: true }, server: { running: true, model: TAG } })),
    ).toMatchObject({ active: true, starting: false });
  });
});
