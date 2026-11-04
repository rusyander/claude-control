import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@shared/config/i18n';
import { endpointProfileName } from './profileName';

/**
 * Имя профиля на экране. Найдено живьём: профиль контура и под английским
 * интерфейсом звался «Контур · …» — сервер хранил приставку в имени. Теперь в
 * имени только название контура, приставку пишет экран на своём языке.
 */

const MANAGED = { name: 'Company · dev', ownerPlatformId: 'company-dev' };
const OWN = { name: 'Мой локальный', ownerPlatformId: '' };

afterEach(async () => {
  await i18n.changeLanguage('ru');
});

describe('endpointProfileName', () => {
  it('en: профиль контура — английская приставка', async () => {
    await i18n.changeLanguage('en');
    expect(endpointProfileName(MANAGED)).toBe('Contour · Company · dev');
  });

  it('ru: профиль контура — русская приставка, как раньше', async () => {
    await i18n.changeLanguage('ru');
    expect(endpointProfileName(MANAGED)).toBe('Контур · Company · dev');
  });

  it('профиль человека — его имя как есть на любом языке', async () => {
    await i18n.changeLanguage('en');
    expect(endpointProfileName(OWN)).toBe('Мой локальный');
  });
});
