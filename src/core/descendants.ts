export interface ParentNode { path: string; parents: string[] }
export interface ReachableNote { path: string; depth: number; via: string | null }
/** Breadth-first traversal keeps one predecessor per note. Memory is linear in nodes and edges. */
export function findDescendants(root: string, nodes: ParentNode[]): ReachableNote[] {
 if (!root) return [];
 const children = new Map<string, Set<string>>();
 for (const node of nodes) for (const parent of node.parents) {
  let list = children.get(parent);
  if (!list) { list = new Set(); children.set(parent, list); }
  list.add(node.path);
 }
 const found: ReachableNote[] = [{ path: root, depth: 0, via: null }], seen = new Set([root]);
 for (let index = 0; index < found.length; index++) {
  const parent = found[index]!;
  for (const path of children.get(parent.path) ?? []) {
   if (seen.has(path)) continue;
   seen.add(path); found.push({ path, depth: parent.depth + 1, via: parent.path });
  }
 }
 return found;
}
export function descendantRoute(root: string, target: string, found: ReachableNote[]): string[] {
 const previous = new Map(found.map((note) => [note.path, note.via]));
 const reverse: string[] = [], seen = new Set<string>(); let path: string | null = target;
 while (path !== null && previous.has(path) && !seen.has(path)) {
  reverse.push(path); seen.add(path);
  if (path === root) return reverse.reverse();
  path = previous.get(path) ?? null;
 }
 return [];
}
export function parentLinkTexts(raw: unknown): { links: string[]; invalid: number } {
 if (raw === null || raw === undefined || raw === '') return { links: [], invalid: 0 };
 const values = Array.isArray(raw) ? raw : [raw]; const links: string[] = []; let invalid = 0;
 for (const value of values) {
  const match = typeof value === 'string' ? /^\[\[([^[\]\r\n]+)\]\]$/.exec(value.trim()) : null;
  const link = match?.[1]?.split('|')[0]?.trim();
  if (link) links.push(link); else invalid++;
 }
 return { links: [...new Set(links)], invalid };
}
