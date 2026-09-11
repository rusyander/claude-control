import { describe, it, expect } from 'vitest';
import type { EndpointProfile } from '@agentdeck/contracts';
import {
  ENDPOINT_API_KINDS,
  ENDPOINT_BASE_URL_SAMPLE,
  isProfileComplete,
  newEndpointProfile,
  removeProfile,
  replaceProfile,
} from './profile';

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

  it('замена по id не трогает исходный массив', () => {
    const next = replaceProfile(list, profileOf({ id: 'ep-2', name: 'Переименован' }));
    expect(next.map((item) => item.name)).toEqual(['Локальная модель', 'Переименован']);
    expect(list[1]?.name).toBe('Второй');
  });

  it('замена несуществующего ничего не добавляет', () => {
    expect(replaceProfile(list, profileOf({ id: 'нет-такого' }))).toEqual(list);
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
