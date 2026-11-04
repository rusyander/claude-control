import { describe, it, expect } from 'vitest';
import type { EndpointProfile } from '@agentdeck/contracts';
import { ENDPOINT_API_KINDS, ENDPOINT_BASE_URL_SAMPLE, newEndpointProfile } from './profile';
import { mergeProfileEdit, sameProfile, shownProfile } from './replaceProfile';
import { removeProfile } from './removeProfile';
import { isProfileComplete } from './isProfileComplete';

/**
 * Список профилей своего эндпоинта на стороне клиента.
 *
 * Здесь заперты два свойства. Первое: новый профиль НИКОМУ не принадлежит —
 * пометку «порождён контуром» ставит только сервер, и профиль человека с такой
 * пометкой пересобирался бы сверкой, то есть терял бы его правки. Второе:
 * правка и удаление не мутируют исходный список — он приходит из кэша запроса,
 * и правка на месте разошлась бы с тем, что покажет следующий рендер.
 */

const profileOf = (patch: Partial<EndpointProfile> = {}): EndpointProfile => ({
  ...newEndpointProfile('ep-1', 'Локальная модель'),
  ...patch,
});

describe('новый профиль', () => {
  it('заполнен по умолчанию и не принадлежит контуру', () => {
    expect(newEndpointProfile('ep-7', 'Свой шлюз')).toEqual({
      id: 'ep-7',
      name: 'Свой шлюз',
      baseUrl: '',
      apiKind: 'openai-compat',
      model: '',
      writeToken: false,
      // Адрес генерации картинок (Т9) пуст и НЕ выводится из `baseUrl`: угаданная
      // ручка дала бы 404 после того, как человек уже описал картинку.
      imagesUrl: '',
      ownerPlatformId: '',
    });
  });

  it('вид API по умолчанию — первый в списке показа', () => {
    expect(newEndpointProfile('ep-1', 'x').apiKind).toBe(ENDPOINT_API_KINDS[0]);
    // У каждого вида есть образец адреса: ошибка здесь стоит человеку получаса.
    for (const kind of ENDPOINT_API_KINDS) expect(ENDPOINT_BASE_URL_SAMPLE[kind]).toBeTruthy();
  });
});

describe('правка списка', () => {
  const list = [profileOf(), profileOf({ id: 'ep-2', name: 'Второй' })];

  it('правка по id не трогает исходный массив', () => {
    const shown = list[1]!;
    const next = mergeProfileEdit(list, shown, { ...shown, name: 'Переименован' });
    expect(next.map((item) => item.name)).toEqual(['Локальная модель', 'Переименован']);
    expect(list[1]?.name).toBe('Второй');
  });

  it('правка несуществующего ничего не добавляет', () => {
    const ghost = profileOf({ id: 'нет-такого' });
    expect(mergeProfileEdit(list, ghost, { ...ghost, name: 'x' })).toEqual(list);
  });

  // Две правки из одной отрисовки: вторая несёт прежнее имя, потому что форма
  // собрала её из того же показанного профиля. Имя из первой правки должно выжить.
  it('правка переносит только своё поле и не возвращает поле, поменянное раньше', () => {
    const shown = list[0]!;
    const afterFirst = mergeProfileEdit(list, shown, { ...shown, name: 'Шлюз' });
    const afterSecond = mergeProfileEdit(afterFirst, shown, {
      ...shown,
      baseUrl: 'http://127.0.0.1:8080',
    });
    expect(afterSecond[0]).toMatchObject({ name: 'Шлюз', baseUrl: 'http://127.0.0.1:8080' });
  });

  // Набранное держится, пока кеш настроек не оповестил отрисовку; чужой профиль
  // набранным не подменяется.
  it('форма показывает набранное своего профиля и настройки — чужого', () => {
    const typed = profileOf({ baseUrl: 'http://1' });
    expect(shownProfile(profileOf(), typed)).toBe(typed);
    expect(shownProfile(list[1], typed)).toBe(list[1]);
    expect(shownProfile(profileOf(), null)).toEqual(profileOf());
    expect(shownProfile(undefined, typed)).toBeUndefined();
  });

  it('настройки догнали набранное — профили равны, отстали на поле — нет', () => {
    expect(sameProfile(profileOf({ name: 'a' }), profileOf({ name: 'a' }))).toBe(true);
    expect(sameProfile(profileOf({ baseUrl: 'h' }), profileOf({ baseUrl: 'ht' }))).toBe(false);
    const { imagesUrl: _dropped, ...withoutImages } = profileOf();
    expect(sameProfile(profileOf(), withoutImages as EndpointProfile)).toBe(false);
  });

  it('удаление убирает ровно один и оставляет остальные', () => {
    expect(removeProfile(list, 'ep-1').map((item) => item.id)).toEqual(['ep-2']);
    expect(removeProfile(list, 'нет-такого')).toEqual(list);
  });
});

describe('готовность профиля', () => {
  it('пустой адрес — не готов', () => {
    expect(isProfileComplete(profileOf({ baseUrl: '   ' }))).toBe(false);
  });

  it('http и https принимаются', () => {
    expect(isProfileComplete(profileOf({ baseUrl: 'http://127.0.0.1:11434/v1' }))).toBe(true);
    expect(isProfileComplete(profileOf({ baseUrl: ' https://gw.example.com ' }))).toBe(true);
  });

  it('чужая схема и не-адрес отвергаются кнопкой, а не сервером', () => {
    expect(isProfileComplete(profileOf({ baseUrl: 'ftp://gw.example.com' }))).toBe(false);
    expect(isProfileComplete(profileOf({ baseUrl: 'не адрес' }))).toBe(false);
  });
});
