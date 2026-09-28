// Deterministic three-way merge. A bounded LCS keeps independent line edits;
// very large inputs use a conservative single hunk and may require manual resolution.
type Edit = { start: number; end: number; lines: string[] };
function edits(base: string[], next: string[]): Edit[] {
  let prefix = 0,
    suffix = 0;
  while (
    prefix < base.length &&
    prefix < next.length &&
    base[prefix] === next[prefix]
  )
    prefix++;
  while (
    suffix < base.length - prefix &&
    suffix < next.length - prefix &&
    base[base.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  const a = base.slice(prefix, base.length - suffix),
    b = next.slice(prefix, next.length - suffix);
  if (!a.length && !b.length) return [];
  if (a.length * b.length > 1_000_000)
    return [{ start: prefix, end: base.length - suffix, lines: b }];
  const dp = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] =
        a[i] === b[j]
          ? 1 + dp[i + 1][j + 1]
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Edit[] = [];
  let i = 0,
    j = 0,
    edit: Edit | undefined;
  const flush = () => {
    if (edit) {
      out.push(edit);
      edit = undefined;
    }
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
      continue;
    }
    edit ??= { start: prefix + i, end: prefix + i, lines: [] };
    if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j]))
      edit.lines.push(b[j++]);
    else {
      i++;
      edit.end = prefix + i;
    }
  }
  flush();
  return out;
}
export function mergeText(
  base: string | null,
  source: string,
  target: string,
): { conflict: boolean; content: string } {
  if (source === target) return { conflict: false, content: target };
  if (base === null) return { conflict: true, content: source };
  if (source === base) return { conflict: false, content: target };
  if (target === base) return { conflict: false, content: source };
  const lines = base.split("\n"),
    a = edits(lines, source.split("\n")),
    b = edits(lines, target.split("\n"));
  const merged = [...a];
  for (const y of b) {
    let duplicate = false;
    for (const x of a) {
      if (
        x.start === y.start &&
        x.end === y.end &&
        JSON.stringify(x.lines) === JSON.stringify(y.lines)
      ) {
        duplicate = true;
        continue;
      }
      const overlap =
        x.start === x.end || y.start === y.end
          ? Math.max(x.start, y.start) <= Math.min(x.end, y.end)
          : Math.max(x.start, y.start) < Math.min(x.end, y.end);
      if (overlap) return { conflict: true, content: source };
    }
    if (!duplicate) merged.push(y);
  }
  for (const e of merged.sort((x, y) => y.start - x.start))
    lines.splice(e.start, e.end - e.start, ...e.lines);
  return { conflict: false, content: lines.join("\n") };
}

