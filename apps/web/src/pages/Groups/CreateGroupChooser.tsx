import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import type { CreateGroupChooserProps, CreateGroupKind } from './CreateGroupChooser.types';
import styles from './CreateGroupChooser.module.scss';

const KINDS: { kind: CreateGroupKind; icon: 'play' | 'groups' }[] = [
  { kind: 'scenario', icon: 'play' },
  { kind: 'bundle', icon: 'groups' },
];

/**
 * Одна кнопка «Создать группу» на странице и здесь — выбор вида. Рядом стояли
 * «Создать группу» и «Создать сценарий», и разница не читалась (владелец 28.09):
 * обе создают группу, различие — в том, КАК идёт работа. Сценарий — шаги по
 * порядку и есть вся работа; набор — участники, которые включаются вместе, а
 * работа идёт по стадиям конвейера. Каждый вариант сам говорит это одной фразой.
 */
export function CreateGroupChooser({ isOpen, onOpenChange, onPick }: CreateGroupChooserProps) {
  const { t } = useTranslation();
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('groupsPage.create.title')}
      description={t('groupsPage.create.description')}
      size="fit"
    >
      <ul className={styles.options}>
        {KINDS.map(({ kind, icon }) => (
          <li key={kind}>
            <button
              type="button"
              className={styles.option}
              aria-describedby={`create-group-${kind}-text`}
              onClick={() => onPick(kind)}
            >
              <span className={styles.icon} aria-hidden="true">
                <Icon name={icon} size={20} />
              </span>
              <span className={styles.text}>
                <Typography variant="body" weight="medium" as="span">
                  {t(`groupsPage.create.${kind}`)}
                </Typography>
                <Typography
                  variant="body-sm"
                  color="muted"
                  as="span"
                  id={`create-group-${kind}-text`}
                >
                  {t(`groupsPage.create.${kind}Text`)}
                </Typography>
              </span>
              <span className={styles.chevron} aria-hidden="true">
                <Icon name="chevronRight" size={20} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
