import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useBoardWaiting } from '@entities/CoreTask';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';

/**
 * Доска из чата (этап 12, D11): кнопка «Доска», а когда карточки ждут человека — «Доска · ждёт вас:
 * N». Число — из того же ответа доски ядра, что у раздела `/core` (один запрос на оба, P160), а не
 * из вопросов этого чата: задача другого чата тоже ждёт вас. Ответа нет — просто «Доска».
 */
export function CoreBoardButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const waiting = useBoardWaiting();
  const shown = waiting !== undefined && waiting > 0;
  return (
    <Button
      variant={shown ? 'secondary' : 'ghost'}
      size="sm"
      leftIcon={<Icon name="layers" size={20} />}
      onClick={() => void navigate({ to: '/core', search: { view: 'board' } } as never)}
      title={t('coreBoard.chat.hint')}
      data-chat-board
      data-board-waiting={shown ? waiting : undefined}
    >
      <span data-bar-label="">
        {shown ? t('coreBoard.chat.waiting', { count: waiting }) : t('coreBoard.chat.button')}
      </span>
    </Button>
  );
}
