import { parseGuid } from '../library/guid';
import { parseOffsetDate } from '../library/offset-date';
import { foldText } from '../library/text-fold';
import { cutPrefix } from '../text/utf16-cut';
import { MAX_CHAIN_DEPTH, PROJECT_NAME_MAX } from './project';

/** What every project name is compared by: case and accents do not count. */
export function foldProjectName(name: string): string {
  return foldText(name.trim());
}

export type NameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: 'empty-name' | 'too-long' };

/** Trims the name and checks its length (1 to 120 characters). */
export function validateProjectName(name: string): NameCheck {
  const trimmed = name.trim();
  if (trimmed === '') return { ok: false, reason: 'empty-name' };
  if (trimmed.length > PROJECT_NAME_MAX) return { ok: false, reason: 'too-long' };
  return { ok: true, name: trimmed };
}

/** True when another project already has this name (folded). */
export function isProjectNameTaken(
  projects: readonly { readonly id: string; readonly name: string }[],
  name: string,
  exceptId: string | null,
): boolean {
  const folded = foldProjectName(name);
  return projects.some((p) => p.id !== exceptId && foldProjectName(p.name) === folded);
}

const SEPARATOR = ' – ';

/** An entry of the folder list written by earlier versions, as the reader hands it over (nothing validated yet). */
export interface LegacyFolderEntry {
  readonly id: string | null;
  readonly name: string | null;
  readonly parentId: string | null;
  readonly note: string | null;
  readonly createdAt: string | null;
}

export interface PlannedProject {
  readonly id: string;
  /** Final, unique by folded text. */
  readonly name: string;
  /** The former folder note. */
  readonly instructions: string;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
  /** The parent the project had in the old list after loops and missing parents became roots. */
  readonly parentId: string | null;
  /** The parent id as written in the old list, when it was a valid id. For `origin`. */
  readonly originalParentId: string | null;
  /** The name before collisions were resolved. */
  readonly originalName: string;
  /** The chain was a loop, or deeper than `MAX_CHAIN_DEPTH`: the folder became a root. */
  readonly cycleBroken: boolean;
}

export interface SkippedEntry {
  readonly index: number;
  readonly reason: 'invalid-id' | 'duplicate-id';
}

export interface ProjectPlan {
  readonly projects: readonly PlannedProject[];
  readonly skipped: readonly SkippedEntry[];
  readonly renamed: readonly { readonly id: string; readonly from: string; readonly to: string }[];
}

interface Node {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly createdAt: string;
}

function depthOf(id: string, byId: ReadonlyMap<string, Node>): number {
  let depth = 0;
  const seen = new Set<string>([id]);
  for (let at = byId.get(id)?.parentId ?? null; at !== null; at = byId.get(at)?.parentId ?? null) {
    if (seen.has(at)) break;
    seen.add(at);
    depth += 1;
  }
  return depth;
}

function chainNames(id: string, byId: ReadonlyMap<string, Node>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (
    let at: string | null = id;
    at !== null && !seen.has(at);
    at = byId.get(at)?.parentId ?? null
  ) {
    seen.add(at);
    const node = byId.get(at);
    if (node === undefined) break;
    names.unshift(node.name);
  }
  return names;
}

/**
 * The collision rule of the folder to project migration. Names that are unique (compared with
 * `foldText`) are kept. A colliding folder that has a parent becomes `<parent> – <name>`; if that
 * still collides, the whole ancestor chain is used; if it still collides, ` 2`, ` 3` follow in a
 * fixed order (depth, createdAt, id). Roots keep their name; a renamed result that collides with
 * one gets the number. Every result is at most 120 characters.
 *
 * Parents must form a forest (no loops): `planProjects` guarantees it.
 */
export function resolveMigratedNames(nodes: readonly Node[]): Map<string, string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map(nodes.map((n) => [n.id, depthOf(n.id, byId)]));
  const order = [...nodes].sort(
    (a, b) =>
      (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const groupSize = new Map<string, number>();
  for (const n of nodes) {
    const key = foldText(n.name);
    groupSize.set(key, (groupSize.get(key) ?? 0) + 1);
  }
  const parentOf = (n: Node): Node | undefined =>
    n.parentId === null ? undefined : byId.get(n.parentId);
  const isRenamed = (n: Node): boolean =>
    (groupSize.get(foldText(n.name)) ?? 0) > 1 && parentOf(n) !== undefined;

  const prefixed = new Map<string, string>();
  for (const n of nodes) {
    const parent = parentOf(n);
    if (isRenamed(n) && parent !== undefined)
      prefixed.set(n.id, cutPrefix(`${parent.name}${SEPARATOR}${n.name}`, PROJECT_NAME_MAX));
  }
  const prefixedSize = new Map<string, number>();
  for (const value of prefixed.values()) {
    const key = foldText(value);
    prefixedSize.set(key, (prefixedSize.get(key) ?? 0) + 1);
  }

  const taken = new Set<string>();
  const result = new Map<string, string>();
  const claim = (id: string, wanted: string): void => {
    let candidate = cutPrefix(wanted, PROJECT_NAME_MAX);
    for (let n = 2; taken.has(foldText(candidate)); n += 1) {
      const suffix = ` ${String(n)}`;
      candidate = `${cutPrefix(wanted, PROJECT_NAME_MAX - suffix.length)}${suffix}`;
    }
    taken.add(foldText(candidate));
    result.set(id, candidate);
  };

  for (const n of order) if (!isRenamed(n)) claim(n.id, n.name);
  for (const n of order) {
    if (!isRenamed(n)) continue;
    const first = prefixed.get(n.id) ?? n.name;
    const stillCollides = (prefixedSize.get(foldText(first)) ?? 0) > 1;
    claim(n.id, stillCollides ? chainNames(n.id, byId).join(SEPARATOR) : first);
  }
  return result;
}

const cleanName = (raw: string | null): string => {
  const trimmed = (raw ?? '').trim();
  return trimmed === '' ? 'Project' : cutPrefix(trimmed, PROJECT_NAME_MAX);
};

/**
 * Turns the raw folder list written by earlier versions into the projects to write. Pure: no file is read or written.
 * Invalid ids are skipped, duplicate ids (after lowercasing) keep the first entry, and a parent
 * that is missing, a loop, a self parent or a chain deeper than `MAX_CHAIN_DEPTH` makes the
 * folder a root. Every walk carries a visited set, so no input can loop.
 */
export function planProjects(
  entries: readonly LegacyFolderEntry[],
  options: { readonly now: string },
): ProjectPlan {
  const skipped: SkippedEntry[] = [];
  const kept: { index: number; id: string; entry: LegacyFolderEntry }[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const id = parseGuid(entry.id);
    if (id === null) {
      skipped.push({ index, reason: 'invalid-id' });
    } else if (seen.has(id)) {
      skipped.push({ index, reason: 'duplicate-id' });
    } else {
      seen.add(id);
      kept.push({ index, id, entry });
    }
  });

  const rawParent = new Map<string, string | null>();
  for (const { id, entry } of kept) {
    const parent = parseGuid(entry.parentId);
    rawParent.set(id, parent !== null && seen.has(parent) ? parent : null);
  }

  const broken = new Set<string>();
  const effectiveParent = new Map<string, string | null>();
  for (const { id } of kept) {
    const visited = new Set<string>([id]);
    let steps = 0;
    let at = rawParent.get(id) ?? null;
    let bad = false;
    while (at !== null) {
      steps += 1;
      if (visited.has(at) || steps > MAX_CHAIN_DEPTH) {
        bad = true;
        break;
      }
      visited.add(at);
      at = rawParent.get(at) ?? null;
    }
    // A folder that names itself (or an unknown parent id that matched nothing) has no valid parent.
    if (bad) broken.add(id);
    effectiveParent.set(id, bad ? null : (rawParent.get(id) ?? null));
  }

  const nodes: Node[] = kept.map(({ id, entry }) => {
    const created = parseOffsetDate(entry.createdAt ?? '');
    return {
      id,
      name: cleanName(entry.name),
      parentId: effectiveParent.get(id) ?? null,
      createdAt: created === null ? options.now : new Date(created.ms).toISOString(),
    };
  });
  const names = resolveMigratedNames(nodes);

  const renamed: { id: string; from: string; to: string }[] = [];
  const projects: PlannedProject[] = kept.map(({ id, entry }, at) => {
    const node = nodes[at];
    if (node === undefined) throw new Error('unreachable: node and entry lists differ');
    const name = names.get(id) ?? node.name;
    if (name !== node.name) renamed.push({ id, from: node.name, to: name });
    const parent = parseGuid(entry.parentId);
    return {
      id,
      name,
      instructions: entry.note ?? '',
      createdAt: node.createdAt,
      parentId: node.parentId,
      originalParentId: parent,
      originalName: node.name,
      cycleBroken: broken.has(id),
    };
  });
  return { projects, skipped, renamed };
}
