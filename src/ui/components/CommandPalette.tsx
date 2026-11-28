/**
 * Sleek Netcatty-style Command Palette (Cmd/Ctrl+K) (P0-3).
 * Fuzzy-searches across Connections, Tables/Views/Collections, Open Tabs, and Actions.
 */

import React, { useMemo, useState } from 'react';
import { Icon, type IconName } from '../../Icon';

export interface CommandPaletteItem {
  id: string;
  group: 'action' | 'tab' | 'connection' | 'object';
  title: string;
  subtitle?: string;
  badge?: string;
  shortcut?: string;
  icon: IconName;
  onSelect: () => void;
}

export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const target = text.toLowerCase();
  const idx = target.indexOf(q);
  if (idx === 0) return 1000 - target.length;
  if (idx > 0) return 600 - idx;
  // Subsequence match
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let i = 0; i < target.length && qi < q.length; i++) {
    if (target[i] === q[qi]) {
      qi++;
      consecutive++;
      score += 10 + consecutive * 5;
    } else {
      consecutive = 0;
    }
  }
  return qi === q.length ? score : 0;
}

export function filterPaletteItems(
  items: readonly CommandPaletteItem[],
  query: string,
): CommandPaletteItem[] {
  const q = query.trim();
  if (!q) return items.slice(0, 40);
  const scored: Array<{ item: CommandPaletteItem; score: number }> = [];
  for (const item of items) {
    const s = Math.max(
      fuzzyScore(q, item.title),
      item.subtitle ? Math.floor(fuzzyScore(q, item.subtitle) * 0.7) : 0,
      item.badge ? Math.floor(fuzzyScore(q, item.badge) * 0.6) : 0,
    );
    if (s > 0) scored.push({ item, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  return scored.slice(0, 40).map((s) => s.item);
}

export interface CommandPaletteProps {
  open: boolean;
  items: CommandPaletteItem[];
  t: (key: string, vars?: Record<string, string | number>) => string;
  onClose: () => void;
}

const GROUP_LABELS: Record<CommandPaletteItem['group'], string> = {
  action: 'Actions',
  tab: 'Open Tabs',
  connection: 'Connections',
  object: 'Tables & Views',
};

export function CommandPalette({ open, items, t, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => filterPaletteItems(items, query), [items, query]);
  const safeIndex = filtered.length > 0 ? Math.min(activeIndex, filtered.length - 1) : 0;

  if (!open) return null;

  const executeItem = (item: CommandPaletteItem | undefined) => {
    if (!item) return;
    setQuery('');
    setActiveIndex(0);
    onClose();
    item.onSelect();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length > 0) setActiveIndex((prev) => (prev + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length > 0) setActiveIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      executeItem(filtered[safeIndex]);
    }
  };

  // Group filtered items preserving order
  let flatIdx = 0;
  const groups: Array<{ group: CommandPaletteItem['group']; entries: Array<{ item: CommandPaletteItem; index: number }> }> = [];
  const byGroup = new Map<CommandPaletteItem['group'], Array<{ item: CommandPaletteItem; index: number }>>();
  for (const item of filtered) {
    const arr = byGroup.get(item.group) ?? [];
    arr.push({ item, index: flatIdx++ });
    byGroup.set(item.group, arr);
  }
  for (const g of ['action', 'tab', 'connection', 'object'] as const) {
    const entries = byGroup.get(g);
    if (entries && entries.length > 0) groups.push({ group: g, entries });
  }

  return (
    <div
      className="ndb-palette-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('Command Palette')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="ndb-palette-card">
        <div className="ndb-palette-input-row">
          <Icon name="search" />
          <input
            type="text"
            autoFocus
            placeholder={t('Search connections, tables, tabs, or actions...')}
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setActiveIndex(0);
            }}
          />
          <span className="ndb-kbd ndb-mono">ESC</span>
        </div>

        <div className="ndb-palette-list" role="listbox">
          {filtered.length === 0 ? (
            <div className="ndb-palette-empty">{t('No matching commands or objects')}</div>
          ) : (
            groups.map(({ group, entries }) => (
              <div key={group} className="ndb-palette-group">
                <div className="ndb-palette-group-label">{t(GROUP_LABELS[group])}</div>
                {entries.map(({ item, index }) => {
                  const active = index === safeIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`ndb-palette-item ${active ? 'is-active' : ''}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => executeItem(item)}
                    >
                      <Icon name={item.icon} />
                      <span className="ndb-palette-item-main">
                        <strong className="ndb-truncate">{item.title}</strong>
                        {item.subtitle && <small className="ndb-truncate ndb-mono">{item.subtitle}</small>}
                      </span>
                      {item.badge && <span className="ndb-tag">{item.badge}</span>}
                      {item.shortcut && <span className="ndb-kbd ndb-mono">{item.shortcut}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
