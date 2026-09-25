/** Отметки «разрешено автоматически» группы: кому адресоваться и что прошло. */
export interface GroupAutoNoticesState {
  parentChatId: string;
  index: number;
  notices: { at: string; summary: string }[];
}

export interface GroupAutoNoticesProps {
  autoNotices: GroupAutoNoticesState;
}
