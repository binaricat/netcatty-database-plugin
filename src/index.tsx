/**
 * Netcatty Database Plugin Entrypoint — Full Multi-Database Multi-Database IDE Workbench.
 */

import React, { Suspense, lazy } from 'react';
import { definePlugin } from '@netcatty/plugin-sdk';
import { registerHostReactView } from '@netcatty/plugin-sdk/host-react';
import css from './style.css';
import { DatabaseWorkbench } from './ui/DatabaseWorkbench';
import { createModalBridge } from './ui/sessionManager';

const ConnectionModalView = lazy(() =>
  import('./ui/ConnectionModalView').then((m) => ({ default: m.ConnectionModalView })),
);

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
        () => <DatabaseWorkbench context={context} modalBridge={modalBridge} />,
        css,
      ),
    );
    context.subscriptions.add(
      registerHostReactView(
        context.views,
        'com.binaricat.netcatty-database.connection',
        () => (
          <Suspense fallback={null}>
            <ConnectionModalView context={context} modalBridge={modalBridge} />
          </Suspense>
        ),
        css,
      ),
    );
  },
});
