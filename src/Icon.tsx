import React from 'react';
// Static licensed SVG resources are decoded by main; no SVG code enters the host DOM.
export type IconName = 'database' | 'plus' | 'file-code' | 'play' | 'square' | 'x' | 'chevron-right' | 'chevron-down' | 'table' | 'eye' | 'search' | 'refresh' | 'sparkles' | 'unplug' | 'folder' | 'key' | 'check' | 'alert-circle' | 'loader' | 'arrow-right' | 'panel-left' | 'shield' | 'settings' | 'server' | 'book-open' | 'history';
export function Icon({ name }: { name: IconName }) { return <img className="host-icon" src={`asset:assets/ui/${name}.svg`} alt="" width={16} height={16} aria-hidden="true" />; }
