export interface WorktreeSectionProps {
  /** Каталог, из которого спрашиваем git: любая копия репозитория подходит. */
  path: string;
  /** Идёт другая операция git в этом же поповере — кнопки раздела тоже ждут. */
  busy: boolean;
}
