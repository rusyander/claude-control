import { describe, it, expect } from 'vitest';
import { enterprisePlatformDriver } from '../drivers/enterprise-platform.ts';
import { bridgeUpstreamStatus, readViolations } from './status.ts';

/**
 * Коды контура и перечень нарушений.
 *
 * Главное свойство, которое здесь держится: НАЗВАНИЯ нарушенного наружу идут, а
 * проверявшийся текст — нет. В теле 451 контур вполне может вернуть кусок
 * самого запроса, и «обрежем до 300 символов» тут не спасает: телефон или
 * фамилия стоят в первых же словах.
 */

describe('перечень нарушений: только названия', () => {
  it('берётся категория, а не текст рядом с ней', () => {
    expect(
      readViolations({
        violations: [
          { category: 'pii_phone', text: 'мой телефон 89001234567', span: [3, 14] },
          { guardrail: 'secrets', detected: 'sk-abc123def456' },
        ],
      }),
    ).toEqual(['pii_phone', 'secrets']);
  });

  it('строка-нарушение принимается только если это слово-категория', () => {
    expect(readViolations({ violations: ['pii_inn', 'нашли фамилию Иванов', 'a b c'] })).toEqual([
      'pii_inn',
    ]);
  });

  it('голая строка, похожая на секрет, не выдаётся за название проверки', () => {
    // У строки нет поля, по которому видно, что это категория, а по форме ключ
    // доступа и внутреннее имя хоста — законные идентификаторы. Такая строка
    // уехала бы прямо на экран панели «названием сработавшей проверки».
    expect(
      readViolations({
        violations: [
          'AKIAIOSFODNN7EXAMPLE',
          'db.internal.corp.ru',
          '3f9a1c77b2e84d0fa5c6913e7d2b4088',
          'pii_inn',
        ],
      }),
    ).toEqual(['pii_inn']);
  });

  describe('поля названия объявляет драйвер', () => {
    // Нарушение в той форме, в какой его отдаёт настоящий контур:
    // `mod-guardrailsbox/src/guardrailsbox/models.py:226 RuleViolation`. Общий
    // белый список (`category`, `name`…) в нём не находит ничего, и каждый
    // вердикт уезжал в журнал «без имён» (аудит GW-03).
    const ruleViolation = (ruleName: string | null) => ({
      rule_id: 'r-7',
      rule_name: ruleName,
      rule_type: 'SECRETS',
      action: 'BLOCK',
      mode: 'ENFORCE',
      scope: 'GLOBAL',
      scanner_name: 'Secrets',
      score: 1,
      message: 'Найден ключ AKIAIOSFODNN7EXAMPLE',
      details: { secret_types: ['AWS'] },
    });

    it('название правила от администратора — прозой, текст сработки не выносится', () => {
      const names = readViolations(
        { violations: [ruleViolation('Секреты в запросах')] },
        enterprisePlatformDriver.violationNames,
      );
      expect(names).toEqual(['Секреты в запросах']);
      expect(names.join(' ')).not.toContain('AKIA');
    });

    it('правило без названия называется своим типом', () => {
      expect(
        readViolations(
          { violations: [ruleViolation(null)] },
          enterprisePlatformDriver.violationNames,
        ),
      ).toEqual(['SECRETS']);
    });

    it('проза в поле администратора чистится от управляющих знаков и длины', () => {
      const [name] = readViolations(
        { violations: [ruleViolation(`Строка\nвторая[31m${'я'.repeat(90)}`)] },
        enterprisePlatformDriver.violationNames,
      );
      expect(name).not.toMatch(/\p{C}/u);
      expect(name?.length).toBeLessThanOrEqual(65);
    });

    it('451 контура называет правило в отказе клиенту', () => {
      const bridged = bridgeUpstreamStatus(
        451,
        {
          error: {
            message: 'Request blocked',
            type: 'guardrail_violation',
            code: 'content_policy_violation',
          },
          violations: [ruleViolation('Секреты в запросах')],
        },
        {
          driverRows: enterprisePlatformDriver.statusRows,
          violationNames: enterprisePlatformDriver.violationNames,
        },
      );
      expect(bridged.violations).toEqual(['Секреты в запросах']);
      expect(bridged.message).toContain('Секреты в запросах');
      expect(bridged.message).not.toContain('AKIA');
    });
  });

  it('перечень читается и из вложенного error', () => {
    expect(readViolations({ error: { violations: [{ code: 'policy_x' }] } })).toEqual(['policy_x']);
  });

  it('повторы схлопываются, мусор пропускается', () => {
    expect(
      readViolations({ violations: [{ category: 'a1' }, { category: 'a1' }, 42, null] }),
    ).toEqual(['a1']);
  });

  it('нет перечня — пусто, а не выдумка', () => {
    expect(readViolations(undefined)).toEqual([]);
    expect(readViolations({ violations: 'строка' })).toEqual([]);
  });
});

describe('коды контура → отказ клиенту', () => {
  it.each([
    [400, 400, 'invalid_request_error'],
    [401, 401, 'authentication_error'],
    [402, 402, 'billing_error'],
    [403, 403, 'permission_error'],
    [422, 422, 'invalid_request_error'],
    [429, 429, 'rate_limit_error'],
    [500, 502, 'api_error'],
    [502, 502, 'api_error'],
    [503, 503, 'overloaded_error'],
  ])('%s → %s (%s)', (from, to, code) => {
    const bridged = bridgeUpstreamStatus(
      from,
      {},
      { driverRows: enterprisePlatformDriver.statusRows },
    );
    expect(bridged.status).toBe(to);
    expect(bridged.code).toBe(code);
    expect(bridged.message).not.toBe('');
  });

  it('422 FastAPI: поле и причина названы, а `input` (сам запрос) — нет', () => {
    const bridged = bridgeUpstreamStatus(
      422,
      {
        detail: [
          {
            type: 'missing',
            loc: ['body', 'messages'],
            msg: 'Field required',
            input: { model: 'm', note: 'секрет-из-запроса' },
          },
        ],
      },
      { driverRows: enterprisePlatformDriver.statusRows },
    );
    expect(bridged.message).toContain('messages: Field required');
    expect(bridged.message).not.toContain('секрет-из-запроса');
  });

  it('451 становится обычным отказом запроса с перечнем нарушенного', () => {
    const bridged = bridgeUpstreamStatus(
      451,
      {
        type: 'guardrail_violation',
        code: 'content_policy_violation',
        violations: [{ category: 'pii_phone', text: 'телефон 89001234567' }],
      },
      { driverRows: enterprisePlatformDriver.statusRows },
    );
    // Ни один CLI не ждёт 451: он покажет сырое тело или решит, что сервер лёг.
    expect(bridged.status).toBe(400);
    expect(bridged.code).toBe('content_policy_violation');
    expect(bridged.message).toContain('pii_phone');
    expect(bridged.message).not.toContain('89001234567');
    expect(bridged.violations).toEqual(['pii_phone']);
  });

  it('русский текст контура показывается как есть', () => {
    const bridged = bridgeUpstreamStatus(
      402,
      { error: { message: 'Квота API провайдера исчерпана' } },
      { driverRows: enterprisePlatformDriver.statusRows },
    );
    expect(bridged.message).toContain('Квота API провайдера исчерпана');
  });

  it('незнакомый код не притворяется знакомым', () => {
    const bridged = bridgeUpstreamStatus(418, {}, { driverRows: [] });
    expect(bridged.status).toBe(418);
    expect(bridged.message).toContain('418');
  });

  it('чужой код вне диапазона ошибок отдаётся как отказ связи', () => {
    expect(bridgeUpstreamStatus(0, {}, { driverRows: [] }).status).toBe(502);
  });
});
