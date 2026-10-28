/** Character range eligible for native spellcheck. Blank lines separate paragraphs. */
export function spellFocusRange(text: string, position: number, scope: 'paragraph' | 'section' = 'paragraph'): { from: number; to: number } {
 const pos = Math.max(0, Math.min(text.length, Math.trunc(Number.isFinite(position) ? position : 0)));
 let from = pos > 0 ? text.lastIndexOf('\n', pos - 1) + 1 : 0;
 let to = text.indexOf('\n', pos);
 if (to < 0) to = text.length;
 const blank = (a: number, b: number) => text.slice(a, b).trim() === '';
 if (scope === 'paragraph' || text.length > 2_000_000) {
  if (blank(from, to)) return { from, to };
  while (from > 0) {
   const previous = text.lastIndexOf('\n', from - 2) + 1;
   if (blank(previous, from - 1)) break;
   from = previous;
  }
  while (to < text.length) {
   const next = text.indexOf('\n', to + 1);
   const end = next < 0 ? text.length : next;
   if (blank(to + 1, end)) break;
   to = end;
  }
  return { from, to };
 }
 let sectionFrom = 0;
 let level = 0;
 let fence = '';
 let fenceLength = 0;
 let frontmatter = text.startsWith('---\n') || text.startsWith('---\r\n');
 const linePattern = /[^\n]*(?:\n|$)/g;
 let match: RegExpExecArray | null;
 while ((match = linePattern.exec(text)) && match[0].length) {
  const line = match[0].replace(/\r?\n$/, '');
  const start = match.index;
  if (frontmatter) {
   if (start > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
   continue;
  }
  const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (marker) {
   const run = marker[1]!;
   if (!fence) { fence = run[0]!; fenceLength = run.length; }
   else if (run[0] === fence && run.length >= fenceLength && marker[2]!.trim() === '') fence = '';
   continue;
  }
  if (fence) continue;
  const heading = /^ {0,3}(#{1,6})(?:\s|$)/.exec(line);
  if (!heading) continue;
  const depth = heading[1]!.length;
  if (start <= pos) { sectionFrom = start; level = depth; }
  else if (level === 0 || depth <= level) return { from: sectionFrom, to: Math.max(sectionFrom, start - 1) };
 }
 return { from: sectionFrom, to: text.length };
}
