import { describe, it, expect } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import type { Platform, PlatformRules } from '@agentdeck/contracts';
import { driverFor } from './drivers/index.ts';
import {
  applyManagedRules,
  brokenExclusion,
  platformRuleRows,
  ruleConflicts,
  type OurRulesState,
} from './rules-matrix.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Правила контура и матрица конфликтов (Т7).
 *
 * Ячейка матрицы — не украшение: по ней человек решает, выключать ли одну из
 * сторон. Поэтому проверяется не наличие строки, а её УРОВЕНЬ: подмена данных,
 * ошибочно названная взаимоисключением, стоила бы выключенной защиты панели
 * ровно там, где обе стороны обязаны работать вместе (Р11).
 */

const PLATFORM: Platform = {
  id: 'company-dev',
  title: 'Company · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  budgetSince: '',
  capabilities: [],
  targets: [],
  consumers: ['chat'],
  projectPaths: [],
  agents: [],
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const withRules = (patch: Partial<PlatformRules>, platform: Partial<Platform> = {}): Platform => ({
  ...PLATFORM,
  ...platform,
  rules: { ...PLATFORM.rules, platform: { ...defaultPlatformRules(), ...patch } },
});

const OURS: OurRulesState = {
  dlp: false,
  promptGate: false,
  toolShim: false,
  managedContext: false,
};

const enterprise = driverFor('enterprise-platform');
const compat = driverFor('openai-compat');

describe('список правил контура', () => {
  it('строится из манифеста драйвера и делится на управляемые и только видимые', () => {
    const rows = platformRuleRows(PLATFORM, enterprise);
    const managed = rows.filter((row) => row.field);
    const observed = rows.filter((row) => !row.field);

    expect(managed.map((row) => row.id)).toEqual([
      'platform_tools',
      'platform_tool_mode',
      'generation_preset',
      'enable_thinking',
    ]);
    // У видимого правила обязана быть строка «где этим распоряжаются»: человек,
    // не нашедший галочки, иначе решит, что панель сломалась.
    for (const row of observed) expect(row.where).not.toBe('');
    expect(observed.map((row) => row.id)).toContain('guardrails');
  });

  it('контур, не объявивший о себе ничего, даёт пустой список, а не выдуманный', () => {
    expect(platformRuleRows(PLATFORM, compat)).toEqual([]);
  });

  it('значение показывается словами, а конечный набор — списком допустимых', () => {
    const rows = platformRuleRows(
      withRules({ platformTools: ['web_search', 'code'], enableThinking: 'on' }),
      enterprise,
    );
    expect(rows.find((row) => row.id === 'platform_tools')?.value).toBe('web_search, code');
    expect(rows.find((row) => row.id === 'enable_thinking')?.value).toBe('включено');
    expect(rows.find((row) => row.id === 'platform_tool_mode')?.options).toEqual([
      'loop',
      'single_turn',
    ]);
  });
});

describe('матрица конфликтов — по ячейке на строку', () => {
  it('инструменты платформы ⟷ прослойка: взаимное исключение', () => {
    const cell = ruleConflicts(PLATFORM, enterprise, OURS).find((row) => row.id === 'tools');
    expect(cell?.level).toBe('exclusive');
    expect(cell?.ourRule).toBe('toolShim');
    expect(cell?.active).toBe(false);

    const both = ruleConflicts(withRules({ platformTools: ['web_search'] }), enterprise, {
      ...OURS,
      toolShim: true,
    });
    expect(both.find((row) => row.id === 'tools')?.active).toBe(true);
  });

  it('сторона контура в ячейке — это строка ЕГО драйвера, а не имя платформы компании (аудит DRV-17)', () => {
    // Другой контур вправе назвать список инструментов по-своему: ячейка,
    // указывающая на «platform_tools», подсветила бы строку, которой на его
    // карточке нет, и конфликт читался бы ни к чему не привязанным.
    const renamed = {
      ...enterprise,
      controls: enterprise.controls.map((control) =>
        control.field === 'platformTools' ? { ...control, id: 'litellm_tools' } : control,
      ),
    };
    const cell = ruleConflicts(PLATFORM, renamed, OURS).find((row) => row.id === 'tools');
    expect(cell?.platformRule).toBe('litellm_tools');
    expect(platformRuleRows(PLATFORM, renamed).map((row) => row.id)).toContain(cell?.platformRule);
  });

  it('подмена данных ⟷ наша защита: НЕ выбор из двух, а порядок слоёв (Р11)', () => {
    const cell = ruleConflicts(PLATFORM, enterprise, { ...OURS, dlp: true }).find(
      (row) => row.id === 'anonymization',
    );
    expect(cell?.level).toBe('info');
    // Найдено враждебным ревью Т7: «включены обе стороны» говорилось по ОДНОЙ —
    // нашей. Включил ли владелец контура подмену, панель не знает вовсе, и
    // утверждать состояние чужой системы по своему тумблеру она не вправе.
    expect(cell?.active).toBe(false);
    expect(cell?.oursOnly).toBe(true);
    // Слова важны не меньше уровня: строка существует ровно затем, чтобы
    // человек НЕ выключил одну из сторон.
    expect(cell?.detail).toContain('Не выбор из двух');
    // Проба dev 15.09.2026: по ключу контур не подменил ничего. Строка, обещающая
    // подмену на стороне контура, уговаривала бы человека выключить нашу маску —
    // единственное, что на этом пути данные закрывает.
    expect(cell?.detail).toContain('не гарантирована');
    expect(cell?.detail).not.toContain('сам возвращает значениями');
  });

  it('сжатие истории ⟷ контрольные точки: предупреждение, и загорается по пробе', () => {
    const cell = ruleConflicts(PLATFORM, enterprise, OURS).find((row) => row.id === 'compaction');
    expect(cell?.level).toBe('warning');
    expect(cell?.active).toBe(false);
    expect(
      ruleConflicts(PLATFORM, enterprise, { ...OURS, managedContext: true }).find(
        (row) => row.id === 'compaction',
      )?.active,
    ).toBe(true);
  });

  it('гардрейлы ⟷ гейт промпта: информация о двух отказах', () => {
    const cell = ruleConflicts(PLATFORM, enterprise, { ...OURS, promptGate: true }).find(
      (row) => row.id === 'guardrails',
    );
    expect(cell?.level).toBe('info');
    // Гардрейлы включает владелец контура у себя; панель видит их только по
    // сработавшему 451. Горит наша половина, и подписана она как наша.
    expect(cell?.active).toBe(false);
    expect(cell?.oursOnly).toBe(true);
  });

  it('ячейки нет там, где у контура нет второй стороны', () => {
    expect(ruleConflicts(PLATFORM, compat, { ...OURS, dlp: true, promptGate: true })).toEqual([]);
  });
});

describe('нарушенное взаимное исключение', () => {
  it('называется, когда включены обе стороны', () => {
    const broken = brokenExclusion(withRules({ platformTools: ['web_search'] }), enterprise);
    expect(broken?.id).toBe('tools');
  });

  it('молчит, когда включена одна', () => {
    expect(brokenExclusion(PLATFORM, enterprise)).toBeUndefined();
    expect(
      brokenExclusion(
        withRules({ platformTools: ['web_search'] }, { toolShim: false }),
        enterprise,
      ),
    ).toBeUndefined();
  });
});

describe('подмешивание управляемых правил в тело запроса', () => {
  it('кладёт только заданное: пустое правило поля не создаёт', () => {
    // `tool_choice` — не исключение из правила, а само правило: пустой список
    // инструментов ЗНАЧИТ «выключено», и манифест говорит, каким полем.
    expect(applyManagedRules({ model: 'm' }, PLATFORM, enterprise)).toEqual({
      model: 'm',
      tool_choice: 'none',
    });
  });

  it('пустой список инструментов выключает инструменты контура, а не молчит (ревью Т7, M2)', () => {
    // До ревью «пусто — наверх уходит tool_choice: none» стояло подписью под
    // полем, а на проводе не было ничего: контур брал свои инструменты по
    // умолчанию в самом частом случае — обычном сообщении без инструментов.
    expect(applyManagedRules({}, PLATFORM, enterprise).tool_choice).toBe('none');
    // Список задан — выключать нечего, иначе заданные имена никогда бы не
    // сработали.
    expect(
      applyManagedRules({}, withRules({ platformTools: ['web_search'] }), enterprise).tool_choice,
    ).toBeUndefined();
    // Контур, не объявивший ручки, не получает и выключения: поля у него нет.
    expect(applyManagedRules({}, PLATFORM, compat).tool_choice).toBeUndefined();
  });

  it('имена инструментов и режим цикла уезжают вместе', () => {
    const body = applyManagedRules(
      { model: 'm' },
      withRules({ platformTools: ['web_search'], toolMode: 'single_turn' }, { toolShim: false }),
      enterprise,
    );
    expect(body).toEqual({
      model: 'm',
      platform_tools: ['web_search'],
      platform_tool_mode: 'single_turn',
    });
  });

  it('режим цикла без инструментов не отправляется вовсе', () => {
    const body = applyManagedRules({}, withRules({ toolMode: 'single_turn' }), enterprise);
    expect(body.platform_tool_mode).toBeUndefined();
  });

  it('пресет и размышления кладутся своими полями', () => {
    const body = applyManagedRules(
      {},
      withRules({ generationPreset: '  creative  ', enableThinking: 'on' }),
      enterprise,
    );
    expect(body).toEqual({
      generation_preset: 'creative',
      chat_template_kwargs: { enable_thinking: true },
      tool_choice: 'none',
    });
  });

  describe('размышления: путь на проводе и три состояния (аудит GW-09/DRV-09/MD-02)', () => {
    // Схема контура: `mod-llmbox/src/llmbox/api/chat/schemas.py:115-120` — поля
    // `enable_thinking` верхнего уровня у неё нет, есть только
    // `chat_template_kwargs`, а незнакомый ключ выбрасывается (`extra=ignore`).
    // Штатное употребление поля в самом контуре — `false` (`context/manager.py:225`).
    it('выключено уезжает значением false, а не отсутствием поля', () => {
      const body = applyManagedRules({}, withRules({ enableThinking: 'off' }), enterprise);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(body).not.toHaveProperty('enable_thinking');
    });

    it('по умолчанию поля нет вовсе: решает шаблон модели', () => {
      const body = applyManagedRules({}, withRules({ enableThinking: 'default' }), enterprise);
      expect(body).not.toHaveProperty('chat_template_kwargs');
      expect(body).not.toHaveProperty('enable_thinking');
    });

    it('параметры шаблона клиента дополняются, а не затираются', () => {
      const client = { chat_template_kwargs: { reasoning_effort: 'low', enable_thinking: true } };
      const body = applyManagedRules(client, withRules({ enableThinking: 'off' }), enterprise);
      expect(body.chat_template_kwargs).toEqual({
        reasoning_effort: 'low',
        enable_thinking: false,
      });
      // Объект клиента не правится на месте: след показывает, что прислал он сам.
      expect(client.chat_template_kwargs.enable_thinking).toBe(true);
    });

    it('строка значения называет все три состояния словами', () => {
      const value = (enableThinking: PlatformRules['enableThinking']) =>
        platformRuleRows(withRules({ enableThinking }), enterprise).find(
          (row) => row.id === 'enable_thinking',
        )?.value;
      expect([value('default'), value('on'), value('off')]).toEqual([
        'по умолчанию',
        'включено',
        'выключено',
      ]);
    });
  });

  it('контуру, не объявившему правил, не уходит ничего — даже из полной настройки', () => {
    const body = applyManagedRules(
      { model: 'm' },
      withRules(
        { platformTools: ['web_search'], generationPreset: 'creative', enableThinking: 'on' },
        { driver: 'openai-compat', toolShim: false },
      ),
      compat,
    );
    expect(body).toEqual({ model: 'm' });
  });

  it('исходное тело не переписывается на месте', () => {
    const body = { model: 'm' };
    applyManagedRules(body, withRules({ enableThinking: 'on' }), enterprise);
    expect(body).toEqual({ model: 'm' });
  });
});
