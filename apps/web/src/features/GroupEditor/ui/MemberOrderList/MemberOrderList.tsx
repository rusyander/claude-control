import { useTranslation } from 'react-i18next';
import type { GroupMember } from '@agentdeck/contracts';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { MemberOrderListProps } from './MemberOrderList.types';
import styles from './MemberOrderList.module.scss';
import { pick } from '../../lib/pick';
import { OrderSlot } from './OrderSlot/OrderSlot';

/**
 * «Порядок применения»: участник читается словами — вид, человеческое имя и
 * одна строка «что делает» на языке интерфейса (хук — «перед правкой файла:
 * сверка документации», а не `PreToolUse:1a2b…`). Сырой id — мелко и
 * приглушённо: он нужен, только чтобы найти файл. «+» между строками ставит
 * следующего отмеченного участника на это место.
 */
export function MemberOrderList({
  value,
  labelOf,
  rawLineOf,
  described,
  insertAt,
  onInsertAt,
  onMove,
  onRemove,
}: MemberOrderListProps) {
  const { t, i18n } = useTranslation();
  const describedOf = (member: GroupMember) =>
    described?.members.find((item) => item.kind === member.kind && item.id === member.id);
  const isPending = (member: GroupMember): boolean =>
    Boolean(described?.pending?.includes(`${member.kind}:${member.id}`));

  return (
    <div className={styles.box}>
      <ol className={styles.list}>
        <li className={styles.edge}>
          <OrderSlot
            position={0}
            isActive={insertAt === 0}
            onInsert={() => onInsertAt(0)}
            className={styles.slotReveal}
          />
        </li>
        {value.map((member, index) => {
          const info = describedOf(member);
          const name = pick(info?.title, i18n.language) || labelOf(member);
          const summary = pick(info?.summary, i18n.language);
          let line = summary || info?.description || rawLineOf(member);
          if (!summary && isPending(member)) line = t('groupBuilder.describing');
          return (
            <li key={`${member.kind}:${member.id}`} className={styles.item}>
              <div className={styles.row}>
                <span className={styles.number}>{index + 1}</span>
                <div className={styles.body}>
                  <span className={styles.head}>
                    <Badge tone="neutral">{t(`groups.kind_${member.kind}`)}</Badge>
                    <span className={styles.name}>{name}</span>
                  </span>
                  {line && <span className={styles.line}>{line}</span>}
                  {name !== member.id && (
                    <span
                      className={styles.id}
                      title={t('groupBuilder.members.rawId', { id: member.id })}
                    >
                      {member.id}
                    </span>
                  )}
                </div>
                <div className={styles.actions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="chevronUp" size={16} />}
                    disabled={index === 0}
                    onClick={() => onMove(index, -1)}
                    aria-label={`${t('groups.moveUp')}: ${name}`}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="chevronDown" size={16} />}
                    disabled={index === value.length - 1}
                    onClick={() => onMove(index, 1)}
                    aria-label={`${t('groups.moveDown')}: ${name}`}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Icon name="close" size={16} />}
                    onClick={() => onRemove(index)}
                    aria-label={`${t('groups.removeMember')}: ${name}`}
                  />
                </div>
              </div>
              <OrderSlot
                position={index + 1}
                isActive={insertAt === index + 1}
                onInsert={() => onInsertAt(index + 1)}
                className={styles.slotReveal}
              />
            </li>
          );
        })}
      </ol>
      {insertAt !== undefined && (
        <div className={styles.inserting} role="status">
          <span>{t('groupBuilder.members.inserting', { position: insertAt + 1 })}</span>
          <Button size="sm" variant="ghost" onClick={() => onInsertAt(undefined)}>
            {t('groupBuilder.members.cancelInsert')}
          </Button>
        </div>
      )}
    </div>
  );
}
