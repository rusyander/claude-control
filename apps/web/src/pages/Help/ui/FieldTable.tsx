import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import styles from './help-kit.module.scss';
import type { FieldTableProps } from './help-kit.types';

/**
 * Таблица полей формы. Имена — настоящие, из схем в packages/contracts:
 * по такому имени поле находится и в коде, и в файле конфигурации, а не
 * только в подписи на экране.
 *
 * На узком экране таблица перестраивается в карточки (строки становятся
 * блоками), но остаётся настоящей <table> — заголовки колонок продолжают
 * читаться скринридером.
 */
export function FieldTable({ rows, nameHeader, descriptionHeader, caption }: FieldTableProps) {
  return (
    <table className={styles.fields}>
      {caption && <caption className={styles.fieldsCaption}>{caption}</caption>}
      <thead>
        <tr>
          <th scope="col">{nameHeader}</th>
          <th scope="col">{descriptionHeader}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name}>
            <th scope="row" className={styles.fieldName}>
              <Typography
                variant={row.isMono === false ? 'body-sm' : 'mono'}
                weight="medium"
                as="span"
              >
                {row.name}
              </Typography>
              {row.badge && <Badge tone={row.badgeTone ?? 'neutral'}>{row.badge}</Badge>}
              {row.badge2 && <Badge tone={row.badge2Tone ?? 'neutral'}>{row.badge2}</Badge>}
            </th>
            <td className={styles.fieldDescription}>
              <Typography variant="body-sm" color="muted" as="span">
                {row.description}
              </Typography>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
