import { Player, RawMessage } from '@minecraft/server';
import { getItemStats, hasItemFlag } from '../stats/item.ts';
import { logger } from './debug.ts';

function stringifyRawMessage(msg: RawMessage): string {
    if (!msg) return '';
    if (msg.text) return msg.text;
    if (msg.translate) return msg.translate;
    if (msg.rawtext) return msg.rawtext.map(stringifyRawMessage).join('');
    return '';
}

export function inventoryAddLore({ source, slot }: { source: Player; slot: number }): void {
    const inv = source.getComponent('inventory')!.container;
    const itemSlot = inv!.getSlot(slot);
    if (!itemSlot.hasItem()) return;

    const { item, stats } = getItemStats(source, itemSlot.getItem() ?? undefined);
    if (!stats) return;

    const existingLore = item?.getRawLore() ?? [];

    const damageStr =
        stats.damage !== undefined
            ? {
                  rawtext: [
                      { text: ` §r§2${stats.damage} ` },
                      { translate: 'javamechanics.attribute.attack_damage' },
                  ],
              }
            : null;

    const atkSpeedStr =
        stats.attackSpeed !== undefined
            ? {
                  rawtext: [
                      { text: ` §r§2${stats.attackSpeed} ` },
                      { translate: 'javamechanics.attribute.attack_speed' },
                  ],
              }
            : null;

    function isOurLine(raw: any): boolean {
        const str = stringifyRawMessage(raw) || '';
        if (
            str.includes('javamechanics.item.mainhand') ||
            str.includes('javamechanics.attribute.attack_damage') ||
            str.includes('javamechanics.attribute.attack_speed')
        )
            return true;
        const noColor = str.replace(/§./g, '');
        if (/\bDMG\b/i.test(noColor) || /\bSPD\b/i.test(noColor)) return true;
        if (/\d+(\.\d+)?\s*(DMG|SPD)/i.test(noColor)) return true;
        return false;
    }

    const itemLore = existingLore.filter((line) => !isOurLine(line));

    if (existingLore.length >= 100) return;

    if (stats.skipLore || hasItemFlag(source, 'skip_lore')) {
        itemSlot.setLore([...itemLore]);
    } else {
        const newLore: any[] = [];
        if (damageStr || atkSpeedStr) {
            newLore.push({
                rawtext: [{ text: '§r§7' }, { translate: 'javamechanics.item.mainhand' }],
            });
            if (damageStr) newLore.push(damageStr);
            if (atkSpeedStr) newLore.push(atkSpeedStr);
        }
        itemSlot.setLore([...newLore, ...itemLore]);
    }
}
