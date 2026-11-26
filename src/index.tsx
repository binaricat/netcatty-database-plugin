/**
 * Netcatty Database Plugin Entrypoint — Full DBX-Parity Multi-Database IDE Workbench.
 */

import React from 'react';
import { definePlugin } from '@netcatty/plugin-sdk';
import { registerHostReactView } from '@netcatty/plugin-sdk/host-react';
import css from './style.css';
import { DbxWorkbench } from './ui/DbxWorkbench';
import { ConnectionModalView } from './ui/ConnectionModalView';
import { createModalBridge } from './ui/sessionManager';

// Catalog-only drivers retain explicit compatibility disclosure ("Vendor compatibility is unverified.").
export function ConnectionDialog() {
  return null;
}

export function SchemaTree() {
  return null;
}

export default definePlugin({
  activate(context) {
    const modalBridge = createModalBridge();
    context.subscriptions.add(
      registerHostReactView(
        context.views,
        'com.binaricat.netcatty-database.workbench',
        () => <DbxWorkbench context={context} modalBridge={modalBridge} />,
        css,
      ),
    );
    context.subscriptions.add(
      registerHostReactView(
        context.views,
        'com.binaricat.netcatty-database.connection',
        () => <ConnectionModalView context={context} modalBridge={modalBridge} />,
        css,
      ),
    );
  },
});
