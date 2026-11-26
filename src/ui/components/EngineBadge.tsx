/**
 * Theme-aware 22-Engine brand icon & environment color indicator primitives.
 */

import React from 'react';
import { driverById, type DriverId } from '../../driverRegistry';
import type { EnvColor } from '../types';

export function resolveThemeVariant(theme: string | undefined): 'dark' | 'light' {
  const t = (theme ?? 'dark').toLowerCase();
  return t.includes('light') || t.includes('snow') ? 'light' : 'dark';
}

export function EngineIcon({
  engine,
  theme,
  size = 20,
}: {
  engine: DriverId;
  theme?: string;
  size?: number;
}) {
  const profile = driverById(engine);
  const variant = resolveThemeVariant(theme);
  return (
    <img
      className={`dbx-engine-icon engine-icon engine-${profile.id}`}
      src={`asset:assets/icons/${profile.icon}-${variant}.png`}
      alt={profile.label}
      width={size}
      height={size}
    />
  );
}

export function EnvColorDot({ color }: { color: EnvColor }) {
  if (color === 'none') return null;
  return <span className={`dbx-env-dot dbx-env-${color}`} aria-hidden="true" />;
}
