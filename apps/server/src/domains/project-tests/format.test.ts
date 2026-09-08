import { describe, expect, it } from 'vitest';
import {
  applyParams,
  combineParams,
  expandSteps,
  parametersInSteps,
  pointId,
  stabilityOf,
  stepText,
  summarize,
  toStatus,
  toSteps,
} from '@agentdeck/contracts/test-format';

/**
 * Общие помощники формата кейсов.
 *
 * Живут в контрактах — их читают и сервер, и панель, и телефон, — а прогоняются
 * здесь: у пакета контрактов своего прогона нет, а расходиться этим правилам
 * нельзя. Разойдутся — панель покажет одно число, отчёт другое.
 */
describe('contracts/test-format', () => {
  it('статус узнаётся и по синониму, и по мусору', () => {
    expect(toStatus('ok')).toBe('passed');
    expect(toStatus('fail')).toBe('failed');
    expect(toStatus('BLOCKED')).toBe('blocked');
    expect(toStatus('что-то своё')).toBe('unknown');
    expect(toStatus(undefined)).toBe('unknown');
  });

  it('шаги строкой достраиваются, объекты остаются как есть', () => {
    expect(toSteps(['зайти', { action: 'нажать', expected: 'открылось' }])).toEqual([
      { action: 'зайти' },
      { action: 'нажать', expected: 'открылось' },
    ]);
    expect(stepText({ action: 'ввести', data: 'привет' })).toContain('привет');
  });

  it('ссылка на общий шаг разворачивается в его шаги', () => {
    const shared = [
      { id: 'login', title: 'Вход', steps: [{ action: 'открыть' }, { action: 'ввести логин' }] },
    ];

    const steps = expandSteps(toSteps([{ ref: 'login' }, { action: 'нажать' }]), shared);

    expect(steps).toHaveLength(3);
    expect(steps[0]?.action).toBe('открыть');
  });

  it('параметры находятся в тексте шагов и подставляются', () => {
    const steps = [{ action: 'войти как %role', data: '%login' }];

    expect(parametersInSteps(steps).sort()).toEqual(['login', 'role']);
    expect(applyParams(steps[0]!.action, { role: 'админ' })).toBe('войти как админ');
    // Неизвестное имя остаётся как есть: молча подставленная пустота выглядела
    // бы как пройденный шаг с потерянным значением.
    expect(applyParams('вход %missing', { role: 'админ' })).toBe('вход %missing');
  });

  // Справка панели сама показывает «%браузер», и кейсы здесь пишут по-русски:
  // латинская грамматика имени молча превращала такой параметр в текст —
  // подстановка не срабатывала, а линтер винил человека «объявлен впустую».
  it('имя параметра может быть на любом алфавите', () => {
    const steps = [{ action: 'открыть в %браузер', expected: 'страница на %язык' }];

    expect(parametersInSteps(steps).sort()).toEqual(['браузер', 'язык']);
    expect(applyParams(steps[0]!.action, { браузер: 'chrome' })).toBe('открыть в chrome');
    expect(applyParams('скидка 50% и %браузер', { браузер: 'firefox' })).toBe(
      'скидка 50% и firefox',
    );
  });

  it('попарные комбинации покрывают все пары, но не растут как полный перебор', () => {
    const parameters = [
      { name: 'роль', values: ['админ', 'гость'] },
      { name: 'язык', values: ['ru', 'en'] },
      { name: 'браузер', values: ['chrome', 'firefox'] },
    ];

    const full = combineParams(parameters, 'full');
    const pairwise = combineParams(parameters, 'pairwise');

    expect(full).toHaveLength(8);
    expect(pairwise.length).toBeLessThan(full.length);
    // Каждая пара значений двух любых параметров встречается хотя бы раз —
    // ради этого попарный отбор и делается.
    for (const [left, right] of [
      ['роль', 'язык'],
      ['роль', 'браузер'],
      ['язык', 'браузер'],
    ] as const) {
      for (const a of parameters.find((item) => item.name === left)!.values) {
        for (const b of parameters.find((item) => item.name === right)!.values) {
          expect(pairwise.some((combo) => combo[left] === a && combo[right] === b)).toBe(true);
        }
      }
    }
  });

  it('идентификатор прохода различает окружение и набор параметров', () => {
    const base = pointId('gui', 'gui-001');

    expect(pointId('gui', 'gui-001', 'chrome')).not.toBe(base);
    expect(pointId('gui', 'gui-001', 'chrome', { роль: 'админ' })).not.toBe(
      pointId('gui', 'gui-001', 'chrome', { роль: 'гость' }),
    );
    // Порядок ключей не должен менять идентификатор — иначе результат
    // потерялся бы при следующем прогоне.
    expect(pointId('gui', 'gui-001', 'chrome', { a: '1', b: '2' })).toBe(
      pointId('gui', 'gui-001', 'chrome', { b: '2', a: '1' }),
    );
  });

  it('свод считает по каноническим статусам', () => {
    const summary = summarize([
      { status: 'passed' },
      { status: 'failed' },
      { status: 'blocked' },
      { status: 'skipped' },
      { status: 'passed' },
    ]);

    expect(summary).toMatchObject({ total: 5, passed: 2, failed: 1, blocked: 1, skipped: 1 });
  });

  it('стабильность падает с каждым переключением результата', () => {
    expect(stabilityOf(['passed', 'passed', 'passed']).flips).toBe(0);
    expect(stabilityOf(['passed', 'failed', 'passed']).flips).toBe(2);
    expect(stabilityOf(['passed', 'failed', 'passed']).stability).toBeLessThan(
      stabilityOf(['passed', 'passed', 'failed']).stability,
    );
  });
});
