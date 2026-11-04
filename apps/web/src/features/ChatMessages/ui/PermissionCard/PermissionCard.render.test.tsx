import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CORE_PERMIT_TOOL } from '@agentdeck/contracts/chat-handoff';
import { i18n } from '@shared/config/i18n';
import { PermissionCard } from './PermissionCard';

/**
 * Значок карточки прав (этап 10, G5): имя инструмента CLI — как есть, вопрос права задачи ядра —
 * человеческой подписью «Вопрос ядра» / «Core question» вместо служебного `core-permit`; текст
 * вопроса ядра — строкой, а не JSON с удвоенными обратными косыми.
 */

const noop = (): void => undefined;
const question = 'The step needs a grant to edit C:\\repo\\guarded\\a1.txt (Write)';
const core = { toolName: CORE_PERMIT_TOOL, input: { question }, toolUseId: 'ask-1' };
const bash = { toolName: 'Bash', input: { command: 'ls -la' }, toolUseId: 'tu-1' };

const badges = (html: string): string[] =>
  [...html.matchAll(/class="[^"]*questionBadge[^"]*">([^<]*)</g)].map((m) => m[1] ?? '');

describe('значок карточки прав: вопрос ядра подписан словами', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });
  afterAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('живая карточка: «Вопрос ядра» вместо core-permit, инструмент CLI — своим именем', () => {
    const html = renderToStaticMarkup(
      <PermissionCard permissions={[core, bash]} onDecide={noop} />,
    );
    expect(badges(html)).toEqual(['Вопрос ядра', 'Bash']);
    expect(html).not.toContain('core-permit');
    // Текст вопроса — строкой: путь с одной обратной косой, без обёртки JSON.
    expect(html).toContain('C:\\repo\\guarded\\a1.txt (Write)');
    expect(html).not.toContain('{&quot;question&quot;');
  });

  it('английский интерфейс — «Core question»', async () => {
    await i18n.changeLanguage('en');
    const html = renderToStaticMarkup(<PermissionCard permissions={[core]} onDecide={noop} />);
    expect(badges(html)).toEqual(['Core question']);
  });
});
