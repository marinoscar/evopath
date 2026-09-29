/**
 * A gym's equipment, grouped by category in catalog order (E3.3). Each row
 * shows the name, brand/model, the quantity stepper (or the quantity when the
 * caller cannot write), the origin tags, and Edit/Remove.
 */
import { Fragment, useState } from 'react';
import { Box, Button, Chip, Divider, List, ListItem, Stack, Typography } from '@mui/material';
import {
  EQUIPMENT_CATEGORIES,
  categoryLabel,
  gymErrorMessage,
  type GymEquipment,
} from '../../services/gyms';
import { QuantityStepper } from './QuantityStepper';
import { EquipmentOriginTags } from './EquipmentOriginTags';

export interface EquipmentListProps {
  items: GymEquipment[];
  canWrite: boolean;
  onQuantityChange: (item: GymEquipment, quantity: number) => Promise<void>;
  onEdit: (item: GymEquipment) => void;
  onRemove: (item: GymEquipment) => void;
}

/** Categories in catalog order, then any unknown ones alphabetically. */
export function groupByCategory(items: GymEquipment[]): Array<{ category: string; items: GymEquipment[] }> {
  const groups = new Map<string, GymEquipment[]>();
  for (const item of items) {
    const key = item.equipmentType.category;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const known = EQUIPMENT_CATEGORIES as readonly string[];
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const ia = known.indexOf(a);
      const ib = known.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? known.length : ia) - (ib === -1 ? known.length : ib);
      return a.localeCompare(b);
    })
    .map(([category, rows]) => ({
      category,
      items: [...rows].sort((x, y) => x.equipmentType.name.localeCompare(y.equipmentType.name)),
    }));
}

function EquipmentRow({
  item,
  canWrite,
  onQuantityChange,
  onEdit,
  onRemove,
}: { item: GymEquipment } & Omit<EquipmentListProps, 'items'>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = item.equipmentType.name;
  const detail = [item.brand, item.model].filter(Boolean).join(' ');

  const changeQuantity = async (quantity: number) => {
    setBusy(true);
    setError(null);
    try {
      await onQuantityChange(item, quantity);
    } catch (err) {
      setError(gymErrorMessage(err, 'Could not change the quantity'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ListItem
      disableGutters
      aria-label={name}
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 1, py: 1.5 }}
    >
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{name}</Typography>
          {detail && (
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {detail}
            </Typography>
          )}
        </Box>
        {canWrite ? (
          <QuantityStepper
            value={item.quantity}
            onChange={(q) => void changeQuantity(q)}
            label={`Quantity of ${name}`}
            disabled={busy}
          />
        ) : (
          <Typography color="text.secondary">Quantity {item.quantity}</Typography>
        )}
      </Box>
      {item.notes && (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {item.notes}
        </Typography>
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flexGrow: 1 }}>
          <EquipmentOriginTags item={item} />
        </Box>
        {canWrite && (
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={() => onEdit(item)} disabled={busy} aria-label={`Edit ${name}`}>
              Edit
            </Button>
            <Button
              size="small"
              color="error"
              onClick={() => onRemove(item)}
              disabled={busy}
              aria-label={`Remove ${name}`}
            >
              Remove
            </Button>
          </Stack>
        )}
      </Box>
      {error && (
        <Typography variant="body2" color="error" role="alert">
          {error}
        </Typography>
      )}
    </ListItem>
  );
}

export function EquipmentList({ items, ...rest }: EquipmentListProps) {
  const groups = groupByCategory(items);
  return (
    <Stack spacing={2}>
      {groups.map((group) => {
        const headingId = `equipment-category-${group.category}`;
        return (
          <Box key={group.category} component="section" aria-labelledby={headingId}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography id={headingId} variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
                {categoryLabel(group.category)}
              </Typography>
              <Chip size="small" label={group.items.length} aria-label={`${group.items.length} items`} />
            </Box>
            <List disablePadding>
              {group.items.map((item, index) => (
                <Fragment key={item.id}>
                  {index > 0 && <Divider component="li" aria-hidden />}
                  <EquipmentRow item={item} {...rest} />
                </Fragment>
              ))}
            </List>
          </Box>
        );
      })}
    </Stack>
  );
}

export default EquipmentList;
