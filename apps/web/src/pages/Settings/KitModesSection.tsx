import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { useKit } from '@entities/Kit';
import { KitModesCard } from '@features/KitModes';

/**
 * Переключатель «свой набор / набор панели» в настройках (В2) — та же карточка,
 * что на странице набора, и ссылка туда, где элементы видно и можно править.
 */
export function KitModesSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useKit();
  if (!data) return null;
  return (
    <KitModesCard
      providers={data.providers}
      footer={
        <div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void navigate({ to: '/kit' } as never)}
          >
            {t('kit.openPage')}
          </Button>
        </div>
      }
    />
  );
}
