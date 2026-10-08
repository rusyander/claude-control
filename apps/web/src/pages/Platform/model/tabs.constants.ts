import type { IconName } from '@shared/ui/icon';

/**
 * Вкладки раздела «Контур».
 *
 * Одна колонка из десятка карточек на каждый контур не просматривалась: правила
 * контура стояли на пятом экране под моделями, и человек их просто не находил.
 * Группы — по вопросу, который человек задаёт: «какие контуры есть», «какой
 * моделью отвечает», «какие правила действуют», «какие разделы через него
 * ходят», «что с инструментами и проверками», «какие агенты».
 *
 * `id` попадает в адрес (`/platform?tab=…`), порядок здесь — порядок на экране.
 */
export const PLATFORM_TABS = [
  { id: 'contours', icon: 'plug' },
  { id: 'model', icon: 'link' },
  { id: 'rules', icon: 'rules' },
  { id: 'access', icon: 'permissions' },
  { id: 'tools', icon: 'hooks' },
  { id: 'agents', icon: 'groups' },
] as const satisfies readonly { id: string; icon: IconName }[];
