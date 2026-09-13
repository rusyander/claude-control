import { describe, it, expect } from 'vitest';
import { defaultOurRules } from '@agentdeck/contracts';
import type { Platform, PlatformHealthRecord } from '@agentdeck/contracts';
import {
  cardModel,
  catalogIds,
  consumerModelRows,
  mapRows,
  missingFromCatalog,
  withConsumerModel,
  withMapRow,
  withoutMapRow,
} from './modelsView';
import { defaultPlatformTransport } from '@agentdeck/contracts';

/**
 * Карточка модели контура (Т6): что человек видит и что вправе выбрать.
 *
 * Здесь заперты два обещания, нарушение которых видно не сразу. Первое:
 * карточка НИКОГДА не называет выбором то, чего человек не выбирал, — иначе он
 * ищет свою настройку и не находит. Второе: пустое значение стирает строку, а
 * не пишет пустоту, — пустая модель в словаре отправила бы прогон в контур
 * вообще без модели.
 */

const PLATFORM: Platform = {
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: ['chat', 'tests', 'assistant', 'terminal', 'foreign:qwen'],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: {
    platform: {
      platformTools: [],
      toolMode: 'loop' as const,
      generationPreset: '',
      enableThinking: 'default',
    },
    ours: defaultOurRules(),
  },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const health = (
  models: { id: string; kind?: string; retired?: boolean; imageGeneration?: boolean }[],
): PlatformHealthRecord => ({
  outcome: 'ok',
  reachable: true,
  url: 'https://api.dev.example.ru/v1/models',
  detail: '',
  models,
  capabilities: [],
  limits: {},
  notes: [],
  compromises: [],
  checkedAt: '2026-09-12T10:00:00.000Z',
});

describe('кому имеет смысл переопределять модель', () => {
  it('только те, кто ходит процессом, и только отмеченные', () => {
    // Ассистент ходит управляемым профилем, терминал — записанным файлом: у
    // обоих модель ровно одна, и строка выбора обещала бы то, чего некуда
    // положить.
    expect(consumerModelRows(PLATFORM).map((row) => row.consumer)).toEqual([
      'chat',
      'tests',
      'foreign:qwen',
    ]);
  });

  it('чужой CLI назван своим именем — строку подписывает клиент', () => {
    const row = consumerModelRows(PLATFORM).find((item) => item.consumer === 'foreign:qwen');
    expect(row?.foreign).toBe('qwen');
    expect(consumerModelRows(PLATFORM)[0]?.foreign).toBe('');
  });

  it('выбранное переопределение видно в строке', () => {
    const platform = { ...PLATFORM, consumerModels: { tests: 'enterprise-platform-small' } };
    expect(consumerModelRows(platform).find((row) => row.consumer === 'tests')?.model).toBe(
      'enterprise-platform-small',
    );
  });
});

describe('модель карточки', () => {
  it('выбор человека сильнее каталога', () => {
    const platform = { ...PLATFORM, defaultModel: 'enterprise-platform-large' };
    expect(cardModel(platform, health([{ id: 'enterprise-platform-mid' }]))).toEqual({
      model: 'enterprise-platform-large',
      source: 'default',
    });
  });

  it('без выбора — первая чатовая модель каталога, и это названо подстановкой', () => {
    // Вложение первым в ответе контура — обычное дело, и взять его моделью
    // разговора значило бы отправить чат в модель, которая не отвечает текстом.
    expect(
      cardModel(PLATFORM, health([{ id: 'bge', kind: 'embedding' }, { id: 'enterprise-platform-mid' }])),
    ).toEqual({ model: 'enterprise-platform-mid', source: 'catalog' });
  });

  it('модель рисования подстановкой не становится — тем же правилом, что на сервере', () => {
    const record = health([
      { id: 'enterprise-platform-image', kind: 'chat', imageGeneration: true },
      { id: 'enterprise-platform-mid', kind: 'chat' },
    ]);
    expect(cardModel(PLATFORM, record)).toEqual({ model: 'enterprise-platform-mid', source: 'catalog' });
    expect(catalogIds(record)).toEqual(['enterprise-platform-image', 'enterprise-platform-mid']);
  });

  it('пробы не было — модели нет, и карточка это говорит', () => {
    expect(cardModel(PLATFORM, undefined)).toEqual({ model: '', source: 'none' });
    expect(catalogIds(undefined)).toEqual([]);
  });

  it('вложения и пропавшие модели в выбор не попадают', () => {
    const record = health([
      { id: 'enterprise-platform-mid' },
      { id: 'bge-m3', kind: 'Embedding' },
      { id: 'enterprise-platform-old', retired: true },
    ]);
    expect(catalogIds(record)).toEqual(['enterprise-platform-mid']);
  });
});

describe('сохранённая модель вне каталога', () => {
  it('названа отдельно: настройка, которая действует, не может быть невидимой', () => {
    // Ревью Т6 (B2): такое значение исчезало из списка выбора, поле показывало
    // «Модели пока нет», а уезжала в каждый прогон именно эта модель. Узнать
    // правду можно было только из `state.json`.
    expect(missingFromCatalog(['enterprise-platform-mid'], 'enterprise-platform-retired-2024')).toBe(true);
    expect(missingFromCatalog(['enterprise-platform-mid'], 'enterprise-platform-mid')).toBe(false);
    expect(missingFromCatalog([], '  ')).toBe(false);
  });
});

describe('карта соответствия имён', () => {
  it('строка пишется и стирается', () => {
    const added = withMapRow(PLATFORM, ' sonnet ', ' enterprise-platform-mid ');
    expect(mapRows(added)).toEqual([{ from: 'sonnet', to: 'enterprise-platform-mid', missing: false }]);
    expect(mapRows(withoutMapRow(added, 'sonnet'))).toEqual([]);
  });

  it('правая часть, пропавшая из каталога, помечена', () => {
    // При ДОБАВЛЕНИИ выбор ограничен каталогом, но каталог меняется, и молчащая
    // строка переводила бы имя в будущий 404.
    const added = withMapRow(PLATFORM, 'sonnet', 'enterprise-platform-old');
    expect(mapRows(added, ['enterprise-platform-mid'])[0]?.missing).toBe(true);
    expect(mapRows(added, [])[0]?.missing).toBe(false);
  });

  it('ключ, отличающийся регистром, заменяет прежний, а не встаёт рядом', () => {
    // Перевод ищется регистронезависимо и берёт первое совпадение: две строки
    // выглядели бы двумя настройками, а действовала бы одна — и какая, видно
    // не было.
    const first = withMapRow(PLATFORM, 'sonnet', 'enterprise-platform-mid');
    const second = withMapRow(first, 'Sonnet', 'enterprise-platform-large');
    expect(mapRows(second)).toEqual([{ from: 'Sonnet', to: 'enterprise-platform-large', missing: false }]);
  });

  it('пустое имя слева не сохраняется вовсе', () => {
    // Ключ, которого не бывает, тихо переводил бы ничто во что-то.
    expect(withMapRow(PLATFORM, '   ', 'enterprise-platform-mid')).toEqual(PLATFORM);
  });

  it('правка не трогает исходный контур', () => {
    withMapRow(PLATFORM, 'sonnet', 'enterprise-platform-mid');
    expect(PLATFORM.modelMap).toEqual({});
  });
});

describe('переопределение потребителя', () => {
  it('пустое значение УДАЛЯЕТ строку, а не пишет пустоту', () => {
    // Пустая модель в словаре читалась бы как «модели нет», и прогон ушёл бы
    // без модели вовсе — то есть с моделью по умолчанию самого CLI.
    const set = withConsumerModel(PLATFORM, 'tests', 'enterprise-platform-small');
    expect(set.consumerModels).toEqual({ tests: 'enterprise-platform-small' });
    expect(withConsumerModel(set, 'tests', '  ').consumerModels).toEqual({});
  });
});
