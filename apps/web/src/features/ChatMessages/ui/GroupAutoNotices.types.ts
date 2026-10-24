/**
 * Отметка группы: разрешение по строке «с отметкой» или (`kind: 'answer'`) ответ
 * панели на вопрос группы; `free` — ответ свободным текстом, вариант не подошёл.
 */
export interface GroupAutoNotice {
  at: string;
  summary: string;
  kind?: 'answer';
  free?: boolean;
}

/** Отметки «разрешено / ответ дан автоматически» группы: кому адресоваться и что прошло. */
export interface GroupAutoNoticesState {
  parentChatId: string;
  index: number;
  notices: GroupAutoNotice[];
}

export interface GroupAutoNoticesProps {
  autoNotices: GroupAutoNoticesState;
}
