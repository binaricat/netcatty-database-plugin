/**
 * Standalone Netcatty modal view (`com.binaricat.netcatty-database.connection`)
 * reusing the full 22-engine DBX `ConnectionDrawer`.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { PluginContext } from '@netcatty/plugin-sdk';
import { createUiTranslator } from './i18n';
import type { ModalBridge } from './sessionManager';
import { WorkbenchStorage } from './storage';
import { ConnectionDrawer } from './components/ConnectionDrawer';
import { resolveThemeVariant } from './components/EngineBadge';
import type { SavedConnection } from './types';

export function ConnectionModalView({
  context,
  modalBridge,
}: {
  context: PluginContext;
  modalBridge: ModalBridge;
}) {
  const storage = useMemo(() => new WorkbenchStorage(context), [context]);
  const [theme, setTheme] = useState(context.environment.theme || 'dark');
  const [locale, setLocale] = useState(context.environment.locale || 'en');
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  useEffect(() => {
    const sub = context.environment.onDidChange((ev) => {
      setTheme(ev.theme || 'dark');
      setLocale(ev.locale || 'en');
    });
    return () => sub.dispose();
  }, [context.environment]);

  const t = useMemo(() => createUiTranslator(locale), [locale]);

  const handleSave = async (
    conn: SavedConnection,
    password: string | undefined,
    connectNow: boolean,
    sqliteBytes?: Uint8Array,
  ) => {
    await modalBridge.requestSaveAndConnect(conn, password, connectNow, sqliteBytes);
    // Also persist directly in case the main workbench view is not currently mounted.
    const existing = await storage.loadConnections();
    if (!existing.some((c) => c.id === conn.id)) {
      let hasPassword = conn.hasPassword;
      if (password !== undefined) {
        hasPassword = await storage.savePassword(conn.id, password);
      }
      await storage.saveConnections([...existing, { ...conn, hasPassword }]);
    }
    setDoneMessage(`${conn.name} saved.`);
  };

  return (
    <div
      className="dbx-workbench dbx-modal-surface"
      data-plugin-chrome="full-bleed"
      data-theme={resolveThemeVariant(theme)}
    >
      {doneMessage ? (
        <div className="dbx-empty-center">
          <p>{doneMessage}</p>
          <button
            type="button"
            className="dbx-btn dbx-btn-primary"
            onClick={() => setDoneMessage(null)}
          >
            {t('New Connection')}
          </button>
        </div>
      ) : (
        <ConnectionDrawer
          context={context}
          theme={theme}
          t={t}
          editingConnection={null}
          standalone
          onClose={() => setDoneMessage('Closed')}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
