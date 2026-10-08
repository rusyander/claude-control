import { markdown } from './renderMarkdown.constants';

/** Окружение разбора: `noImages` — картинки ссылками, а не `<img>`. */
export interface RenderEnv {
  noImages?: boolean;
}

/**
 * Документ из репозитория (файл инструкций, markdown в окне кода): картинка —
 * ссылка с подписью, а не `<img>`. Файл пишет кто угодно — клонированный чужой
 * CLAUDE.md с `![](https://…/pixel.png)` заставлял панель при открытии вкладки
 * сходить по чужому адресу (IP, время), а относительная картинка всё равно
 * рисовалась битой: страница панели — не каталог репозитория.
 */
export function renderDocumentMarkdown(text: string): string {
  return markdown.render(text, { noImages: true } satisfies RenderEnv);
}
