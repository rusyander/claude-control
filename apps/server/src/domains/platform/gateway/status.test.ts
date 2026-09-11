import { describe, it, expect } from 'vitest';
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
    const bridged = bridgeUpstreamStatus(from, {});
    expect(bridged.status).toBe(to);
    expect(bridged.code).toBe(code);
    expect(bridged.message).not.toBe('');
  });

  it('451 становится обычным отказом запроса с перечнем нарушенного', () => {
    const bridged = bridgeUpstreamStatus(451, {
      type: 'guardrail_violation',
      code: 'content_policy_violation',
      violations: [{ category: 'pii_phone', text: 'телефон 89001234567' }],
    });
    // Ни один CLI не ждёт 451: он покажет сырое тело или решит, что сервер лёг.
    expect(bridged.status).toBe(400);
    expect(bridged.code).toBe('content_policy_violation');
    expect(bridged.message).toContain('pii_phone');
    expect(bridged.message).not.toContain('89001234567');
    expect(bridged.violations).toEqual(['pii_phone']);
  });

  it('русский текст контура показывается как есть', () => {
    const bridged = bridgeUpstreamStatus(402, {
      error: { message: 'Квота API провайдера исчерпана' },
    });
    expect(bridged.message).toContain('Квота API провайдера исчерпана');
  });

  it('незнакомый код не притворяется знакомым', () => {
    const bridged = bridgeUpstreamStatus(418, {});
    expect(bridged.status).toBe(418);
    expect(bridged.message).toContain('418');
  });

  it('чужой код вне диапазона ошибок отдаётся как отказ связи', () => {
    expect(bridgeUpstreamStatus(0, {}).status).toBe(502);
  });
});
