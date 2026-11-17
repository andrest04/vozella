import type { ShellTag } from '@vozella/core';
import { Briefcase, Library, Mic, Settings, type LucideIcon } from 'lucide-react';
import type { StringKey } from '../../i18n/translate';

export type RailRoute = '/record' | '/projects' | '/library' | '/settings';

export interface NavEntry {
  readonly to: RailRoute;
  readonly label: StringKey;
  readonly icon: LucideIcon;
  /** A stable DOM id for the end-to-end specs and assistive tooling; never shown. */
  readonly automationId:
    'NavItemRecording' | 'NavItemProjects' | 'NavItemHistory' | 'NavItemSettings';
}

/**
 * Rail order: Record, Projects, Library, then Settings. The labels are catalog keys, so every
 * label follows the app language and never the OS language.
 */
export const NAV: readonly NavEntry[] = [
  { to: '/record', label: 'Nav_Record.Content', icon: Mic, automationId: 'NavItemRecording' },
  { to: '/projects', label: 'Ui_NavProjects', icon: Briefcase, automationId: 'NavItemProjects' },
  { to: '/library', label: 'Nav_History.Content', icon: Library, automationId: 'NavItemHistory' },
  { to: '/settings', label: 'Nav_Settings', icon: Settings, automationId: 'NavItemSettings' },
];

const ROUTE_OF_TAG: Readonly<Record<ShellTag, RailRoute | '/session'>> = {
  Recording: '/record',
  Projects: '/projects',
  History: '/library',
  Settings: '/settings',
  Session: '/session',
};

export const routeOfTag = (tag: ShellTag): RailRoute | '/session' => ROUTE_OF_TAG[tag];

/** `/projects`, `/projects/<id>` and `/projects/none`, and nothing that merely starts with it. */
const isProjectsPath = (pathname: string): boolean =>
  pathname === '/projects' || pathname.startsWith('/projects/');

/** The tag published to the workspace for a path; null for a path with no tag. */
export function tagOfPath(pathname: string): ShellTag | null {
  if (isProjectsPath(pathname)) return 'Projects';
  const match = (Object.entries(ROUTE_OF_TAG) as [ShellTag, string][]).find(
    ([, route]) => route === pathname,
  );
  return match ? match[0] : null;
}

/** Which rail entry is selected: Session is not on the rail, so Library stays selected. */
export function railRouteOf(pathname: string): RailRoute | null {
  if (pathname === '/session') return '/library';
  if (isProjectsPath(pathname)) return '/projects';
  return NAV.find((entry) => entry.to === pathname)?.to ?? null;
}

/** The id in `/projects/<id>`; null for the grid, for `/projects/none` and for any other path. */
export function projectIdOfPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)$/.exec(pathname);
  const id = match?.[1];
  return id === undefined || id === 'none' ? null : id;
}
