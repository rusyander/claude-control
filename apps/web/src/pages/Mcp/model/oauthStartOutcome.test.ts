import { describe, it, expect } from 'vitest';
import { oauthStartOutcome } from './oauthStartOutcome';

/**
 * Заблокированное всплывающее окно не должно превращать «Авторизоваться» в
 * кнопку, которая ничего не делает: раньше при `popup === null` ветка с адресом
 * пропускалась целиком — ни окна, ни ссылки, ни ошибки, при заведённом на
 * сервере входе.
 */
describe('oauthStartOutcome', () => {
  it('окно срезал блокировщик — адрес всё равно доезжает до человека', () => {
    expect(
      oauthStartOutcome({ status: 'redirect', authorizationUrl: 'https://auth.test/x' }, false),
    ).toEqual({ kind: 'manual', url: 'https://auth.test/x' });
  });

  it('живое окно ведём на адрес сами', () => {
    expect(
      oauthStartOutcome({ status: 'redirect', authorizationUrl: 'https://auth.test/x' }, true),
    ).toEqual({ kind: 'popup', url: 'https://auth.test/x' });
  });

  it('токен уже есть — входить некуда', () => {
    expect(oauthStartOutcome({ status: 'authorized' }, true)).toEqual({ kind: 'authorized' });
  });

  it('ответ без адреса — отдельный исход, а не тишина', () => {
    expect(oauthStartOutcome({ status: 'redirect' }, true)).toEqual({ kind: 'noUrl' });
    expect(oauthStartOutcome({ status: 'redirect' }, false)).toEqual({ kind: 'noUrl' });
  });
});
