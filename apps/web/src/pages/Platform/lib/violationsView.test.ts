import { describe, it, expect } from 'vitest';
import type { PlatformViolationReport, PlatformViolationRow } from '@agentdeck/contracts';
import { emptyKind, rowTone, showsViolations } from './violationsView';

/**
 * Карточка проверок контура утверждает вещи, которые человек не может проверить
 * сам: что проверок не было, что они ничего не нашли, что ответ пришёл целым.
 * Соврать здесь дороже, чем не показать ничего, — поэтому закреплены ровно те
 * три решения, в которых ложь возможна.
 */

const row = (patch: Partial<PlatformViolationRow> = {}): PlatformViolationRow => ({
  name: 'pii',
  count: 1,
  lastAt: '2026-09-10T10:00:00.000Z',
  actions: ['blocked'],
  platformIds: ['enterprise-platform'],
  ...patch,
});

const report = (patch: Partial<PlatformViolationReport> = {}): PlatformViolationReport => ({
  rows: [],
  total: 0,
  maskedUnnamed: 0,
  blockedUnnamed: 0,
  interruptedUnnamed: 0,
  ...patch,
});

const SINCE = '2026-09-10T09:00:00.000Z';

describe('emptyKind: незнание и молчание — разные вещи', () => {
  it('через шлюз не прошло ни одного запроса — панель не знает ничего', () => {
    expect(emptyKind(report())).toBe('idle');
  });

  it('запросы шли, проверки молчали — это уже утверждение, а не незнание', () => {
    expect(emptyKind(report({ since: SINCE }))).toBe('clean');
  });

  it('есть хотя бы одна названная проверка — пустоты нет', () => {
    expect(emptyKind(report({ since: SINCE, rows: [row()], total: 1 }))).toBe('none');
  });

  it('безымянное срабатывание — не пустота: «проверки молчали» тут было бы враньём', () => {
    // Названия — необязательная часть кадра контура. Отказ, обрыв и маскировка
    // без единого имени показываются своими строками, и `clean` рядом с ними
    // означал бы «ничего не срабатывало» про запрос, который не приняли.
    expect(emptyKind(report({ since: SINCE, blockedUnnamed: 1 }))).toBe('none');
    expect(emptyKind(report({ since: SINCE, interruptedUnnamed: 2 }))).toBe('none');
    expect(emptyKind(report({ since: SINCE, maskedUnnamed: 3 }))).toBe('none');
  });

  it('сводки нет вовсе (старый ответ сервера) — карточка молчит, а не выдумывает', () => {
    expect(emptyKind(undefined)).toBe('none');
  });

  it('сводка пришла неполной — тоже молчим, а не падаем на первом же поле', () => {
    // `getGateway` — обычное приведение типа, схему никто не проверяет: ответ
    // сервера другой версии обязан оставить раздел живым.
    expect(emptyKind({} as PlatformViolationReport)).toBe('none');
    expect(emptyKind({ total: 0 } as PlatformViolationReport)).toBe('none');
  });
});

describe('rowTone: тихое важнее громкого', () => {
  it('маскировка — предупреждение: её человек не увидел сам', () => {
    expect(rowTone(row({ actions: ['masked'] }))).toBe('warning');
  });

  it('отказ и обрыв — опасность: ответа не было или он оборвался на глазах', () => {
    expect(rowTone(row({ actions: ['blocked'] }))).toBe('danger');
    expect(rowTone(row({ actions: ['interrupted'] }))).toBe('danger');
  });

  it('одна проверка с разными исходами: маскировка перевешивает', () => {
    expect(rowTone(row({ actions: ['blocked', 'masked'] }))).toBe('warning');
    expect(rowTone(row({ actions: ['masked', 'interrupted'] }))).toBe('warning');
  });

  it('исход неизвестен — нейтрально, а не «наверное, заблокировали»', () => {
    // На экране такая строка подписана словами «что случилось — контур не
    // сказал»: пустое место рядом с ней читалось бы как «сработала и пропустила».
    expect(rowTone(row({ actions: [] }))).toBe('neutral');
  });
});

describe('showsViolations: выключенный контур возвращает панель к прежнему виду', () => {
  it('карточка есть только при включённом контуре, живом шлюзе и пришедшей сводке', () => {
    expect(showsViolations(true, true, report())).toBe(true);
  });

  it('контур выключен — карточки нет, чем бы ни занимался шлюз', () => {
    expect(showsViolations(false, true, report())).toBe(false);
    expect(showsViolations(false, false, report())).toBe(false);
  });

  it('шлюз не поднят — говорить о проверках нечем', () => {
    expect(showsViolations(true, false, report())).toBe(false);
  });

  it('сводки нет или она неполна — молчим, а не рисуем пустую карточку', () => {
    expect(showsViolations(true, true, undefined)).toBe(false);
    expect(showsViolations(true, true, {} as PlatformViolationReport)).toBe(false);
  });
});
