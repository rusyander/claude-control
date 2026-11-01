import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SIGNAL_IDS, SIGNAL_VIEW } from '@agentdeck/contracts/core/signal-view';
import { i18n } from '@shared/config/i18n';
import { SignalLine } from '../ui/SignalLine/SignalLine';
import { signalView, type SignalItem } from './signalView';

/**
 * Сигнал на экране: у каждого id каталога — заголовок шаблона на обоих языках и подпись предмета;
 * JSON шести сигналов оценки и сессии — фактами по форме, которую пишет ядро; проза — дословно,
 * даже если похожа на JSON; сигнал вне каталога назван id, его JSON — только ключами.
 */

const sig = (signal: string, detail: string, subject = 'estimate'): SignalItem => ({
  type: 'signal',
  signal,
  severity: 'info',
  subject,
  detail,
  action: null,
});

/** Детали JSON — в той форме, в какой их пишет владелец сигнала в `apps/core`. */
const JSON_DETAIL: Record<string, string> = {
  preflight: JSON.stringify([
    { road: 'cli', status: 'ok', detail: 'claude: C:\\bin\\claude.cmd' },
    { road: 'push-closure', status: 'not-checked', detail: 'arrives with publish (05)' },
  ]),
  'estimate-refused': JSON.stringify(['scenario level 2 repo: unknown step kind']),
  'user-layer-report': JSON.stringify({
    report: {
      hash: 'abcdef0123456789',
      asked: { hooks: 'on', skills: 'on' },
      ran: { hooks: 'observe', skills: 'on' },
      detail: ['qwen: no layer control → on'],
      warnings: [{ code: 'x' }],
      sources: 3,
    },
    grants: [],
  }),
  'estimate-history': JSON.stringify({
    minutes: 12,
    tokens: 34000,
    spread: [20000, 50000],
    basis: 'history',
  }),
  'keep-warm': JSON.stringify({ reasons: ['idle 4 min of 5'], numbers: { idleMs: 240000 } }),
  'route-lease': JSON.stringify({
    routeId: 'stub:stand',
    model: 'stub-model',
    rids: ['r-1', 'r-2'],
  }),
};

describe('сигнал на экране', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it.each(['ru', 'en'])('каждый сигнал каталога — заголовок и подпись предмета в %s', (lng) => {
    const t = i18n.getFixedT(lng);
    for (const id of SIGNAL_IDS) {
      const view = signalView(sig(id, '', 'x'));
      expect(view.known, id).toBe(true);
      expect(i18n.exists(view.title.key, { lng }), `${lng}:${view.title.key}`).toBe(true);
      expect(t(view.title.key), id).not.toBe(view.title.key);
      expect(i18n.exists(view.subject!.key, { lng }), `${lng}:${view.subject!.key}`).toBe(true);
    }
  });

  it('JSON каждого сигнала с JSON-деталью — факты, не текст', () => {
    const jsonIds = SIGNAL_IDS.filter((id) => SIGNAL_VIEW[id].detail === 'json');
    expect(jsonIds.sort()).toEqual(Object.keys(JSON_DETAIL).sort());
    for (const id of jsonIds) {
      const { detail } = signalView(sig(id, JSON_DETAIL[id]!));
      expect(detail.form, id).toBe('facts');
    }
  });

  it('предпроверка: дорога — подпись, статус и деталь — значение', () => {
    const { detail } = signalView(sig('preflight', JSON_DETAIL.preflight!));
    expect(detail).toEqual({
      form: 'facts',
      facts: [
        { label: 'cli', value: 'ok — claude: C:\\bin\\claude.cmd' },
        { label: 'push-closure', value: 'not-checked — arrives with publish (05)' },
      ],
    });
  });

  it('слой пользователя: режим просил → вышло, счёт предупреждений и грантов, подмены списком', () => {
    const { detail } = signalView(sig('user-layer-report', JSON_DETAIL['user-layer-report']!));
    expect(detail).toEqual({
      form: 'facts',
      facts: [
        { key: 'hash', value: 'abcdef012345' },
        { key: 'hooks', value: 'on → observe' },
        { key: 'skills', value: 'on' },
        { key: 'sources', value: '3' },
        { key: 'warnings', value: '1' },
        { key: 'grants', value: '0' },
        { key: 'changes', items: ['qwen: no layer control → on'] },
      ],
    });
  });

  it('аренда и история: числа по своим подписям', () => {
    expect(signalView(sig('route-lease', JSON_DETAIL['route-lease']!)).detail).toEqual({
      form: 'facts',
      facts: [
        { key: 'route', value: 'stub:stand' },
        { key: 'model', value: 'stub-model' },
        { key: 'resources', items: ['r-1', 'r-2'] },
      ],
    });
    expect(signalView(sig('estimate-history', JSON_DETAIL['estimate-history']!)).detail).toEqual({
      form: 'facts',
      facts: [
        { key: 'basis', value: 'history' },
        { key: 'minutes', value: '12' },
        { key: 'tokens', value: '34000' },
        { key: 'spread', value: '20000–50000' },
      ],
    });
  });

  it('проза известного сигнала — дословно, даже похожая на JSON', () => {
    // Валидный JSON: без правила «проза — дословно» он ушёл бы в ключи.
    const text = '{"tool":"Bash","event":"PreToolUse"}';
    expect(signalView(sig('hook-block', text)).detail).toEqual({ form: 'text', text });
  });

  it('JSON-сигнал с битой деталью — честно текстом, без выдуманных фактов', () => {
    expect(signalView(sig('preflight', 'garbage')).detail).toEqual({
      form: 'text',
      text: 'garbage',
    });
    // Форма сменилась (объект вместо строк) — ключи, а не факты.
    expect(signalView(sig('preflight', '{"rows":[]}')).detail).toEqual({
      form: 'keys',
      keys: [{ key: 'rows', value: '[0]' }],
    });
  });

  it('сигнал вне каталога: назван id, JSON — ключами, текст — дословно', () => {
    const view = signalView(sig('brand-new', '{"a":1,"nested":{"x":1,"y":2},"list":[1,2,3]}'));
    expect(view.known).toBe(false);
    expect(view.title).toEqual({
      key: 'coreTimeline.signal.unknown',
      params: { signal: 'brand-new' },
    });
    expect(view.subject?.key).toBe('coreTimeline.signal.subject');
    expect(view.detail).toEqual({
      form: 'keys',
      keys: [
        { key: 'a', value: '1' },
        { key: 'nested', value: '{2}' },
        { key: 'list', value: '[3]' },
      ],
    });
    expect(signalView(sig('brand-new', 'plain words')).detail).toEqual({
      form: 'text',
      text: 'plain words',
    });
  });

  it('разметка: предпроверка без дампа JSON, вне каталога — с id и ключами', () => {
    const pre = renderToStaticMarkup(
      <SignalLine signal={sig('preflight', JSON_DETAIL.preflight!)} tone="info" />,
    );
    expect(pre).toContain('Предпроверка запуска');
    expect(pre).toContain('Этап');
    expect(pre).toContain('push-closure');
    expect(pre).not.toContain('{&quot;road');
    expect(pre).not.toContain('"road"');
    const unknown = renderToStaticMarkup(
      <SignalLine signal={sig('brand-new', '{"a":1}')} tone="info" withSeverity />,
    );
    expect(unknown).toContain('Сигнал вне каталога: brand-new');
    expect(unknown).toContain('a: 1');
    expect(unknown).not.toContain('{&quot;a');
  });
});
