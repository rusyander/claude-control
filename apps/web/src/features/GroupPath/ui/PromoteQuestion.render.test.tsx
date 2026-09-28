import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { PromoteQuestion } from './PromoteQuestion';

const promote = { type: 'hook' as const, draft: '{"event":"PostToolUse"}' };
const noop = (): void => undefined;

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('вопрос «сделать ресурсом»: куда ляжет файл', () => {
  it('у глобальной группы — каталог провайдера', () => {
    const html = renderToStaticMarkup(
      <PromoteQuestion promote={promote} isPending={false} onAccept={noop} onDecline={noop} />,
    );
    expect(html).toContain('в каталоге провайдера');
    expect(html).not.toContain('.claude проекта');
  });

  it('у проектной — .claude её проекта, а не общий каталог', () => {
    const html = renderToStaticMarkup(
      <PromoteQuestion
        promote={promote}
        isPending={false}
        projectPath="C:/work/shop"
        onAccept={noop}
        onDecline={noop}
      />,
    );
    expect(html).toContain('в .claude проекта C:/work/shop');
    expect(html).not.toContain('в каталоге провайдера');
  });
});
