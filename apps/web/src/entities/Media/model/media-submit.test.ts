import { describe, expect, it } from 'vitest';
import type { MediaDeck, MediaDeckPlan, MediaImagePlan } from '@agentdeck/contracts';
import { composerFlags, planMediaSubmit } from './media-submit';

const imagePlan = (patch: Partial<MediaImagePlan> = {}): MediaImagePlan => ({
  available: true,
  source: 'contour-chat',
  title: 'Контур',
  model: 'draw-l',
  promptSent: true,
  compromise: 'media-by-capability',
  ...patch,
});

const deckPlan = (patch: Partial<MediaDeckPlan> = {}): MediaDeckPlan => ({
  available: true,
  source: 'contour',
  title: 'Контур',
  model: 'chat-l',
  pdf: { available: true },
  compromise: 'media-by-capability',
  ...patch,
});

const deck = (patch: Partial<MediaDeck> = {}): MediaDeck => ({
  id: 'abcdef0123456789',
  chatId: 'chat-1',
  title: 'Итоги квартала',
  slideCount: 9,
  prompt: 'итоги квартала',
  model: 'chat-l',
  source: 'contour',
  createdAt: '2026-09-13T00:00:00.000Z',
  formats: ['html', 'pptx'],
  sizeBytes: 1024,
  ...patch,
});

describe('planMediaSubmit', () => {
  it('в текстовом режиме и на пустом поле делать нечего', () => {
    expect(planMediaSubmit('text', 'привет', { image: imagePlan() })).toBeUndefined();
    expect(planMediaSubmit('image', '   ', { image: imagePlan() })).toBeUndefined();
  });

  it('картинку рисует панель, а на дороге агента — просьба в разговор', () => {
    expect(planMediaSubmit('image', '  кот на окне  ', { image: imagePlan() })).toEqual({
      road: 'image',
      prompt: 'кот на окне',
    });
    expect(
      planMediaSubmit('image', 'кот на окне', { image: imagePlan({ source: 'agent' }) }),
    ).toEqual({ road: 'agent', kind: 'picture', topic: 'кот на окне' });
  });

  it('колода без правки: своя дорога несёт только тему', () => {
    expect(planMediaSubmit('deck', 'итоги квартала', { deck: deckPlan() })).toEqual({
      road: 'deck',
      prompt: 'итоги квартала',
    });
    expect(
      planMediaSubmit('deck', 'итоги квартала', { deck: deckPlan({ source: 'agent' }) }),
    ).toEqual({ road: 'agent', kind: 'deck', topic: 'итоги квартала' });
  });

  it('правка несёт прежнюю колоду и на своей дороге, и в просьбе агенту', () => {
    const previous = deck();
    expect(planMediaSubmit('deck', 'третий слайд короче', { deck: deckPlan() }, previous)).toEqual({
      road: 'deck',
      prompt: 'третий слайд короче',
      reviseOf: previous.id,
    });
    // Вид просьбы у агента ДРУГОЙ: в неё сервер вкладывает структуру прежней
    // колоды, и обычная просьба собрала бы новую колоду по той же теме.
    expect(
      planMediaSubmit(
        'deck',
        'третий слайд короче',
        { deck: deckPlan({ source: 'agent' }) },
        previous,
      ),
    ).toEqual({
      road: 'agent',
      kind: 'deck-revise',
      topic: 'третий слайд короче',
      reviseOf: previous.id,
    });
  });

  it('плана ещё нет — отправка идёт своей дорогой, а не выдумывает агента', () => {
    expect(planMediaSubmit('deck', 'итоги', {})).toEqual({ road: 'deck', prompt: 'итоги' });
    expect(planMediaSubmit('image', 'кот', {})).toEqual({ road: 'image', prompt: 'кот' });
  });
});

describe('composerFlags', () => {
  it('доступность, слова причины и дороги переносятся как есть', () => {
    const flags = composerFlags({
      image: { available: false, reasonText: 'рисовать некому' },
      deck: { available: true, sourceText: 'контур · chat-l' },
      plans: {},
      isBusy: false,
    });
    expect(flags).toEqual({
      imageAvailable: false,
      imageReason: 'рисовать некому',
      deckAvailable: true,
      deckSource: 'контур · chat-l',
      isDrawing: false,
    });
  });

  it('дорога агента помечена отдельно: подсказка поля обещала бы неправду', () => {
    const flags = composerFlags({
      image: { available: true, sourceText: 'агент разговора' },
      deck: { available: true },
      plans: { image: imagePlan({ source: 'agent' }) },
      isBusy: true,
    });
    expect(flags.imageByAgent).toBe(true);
    expect(flags.isDrawing).toBe(true);
  });

  it('заголовок правки виден композеру, пока правка не отменена', () => {
    const previous = deck();
    const flags = composerFlags({
      image: { available: true },
      deck: { available: true },
      plans: {},
      isBusy: false,
      revising: previous,
    });
    expect(flags.reviseTitle).toBe(previous.title);
    expect(
      composerFlags({
        image: { available: true },
        deck: { available: true },
        plans: {},
        isBusy: false,
      }).reviseTitle,
    ).toBeUndefined();
  });
});
