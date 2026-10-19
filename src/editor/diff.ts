// Word-level LCS diff. Used by suggestions to show pending text without writing it into the document.
// Tokens are words (including CJK characters) kept together with the whitespace that follows them,
// so a join of every token reconstructs the input.

export type DiffOp = { op: "eq" | "ins" | "del"; text: string };

export function tokenize(s: string): string[] {
  return s.match(/\s+|\S+/g) ?? [];
}

/**
 * Generic LCS diff over token lists compared by `key`. Returns runs of equal / deleted / inserted
 * tokens (for "eq" runs the tokens are taken from B, the new side). O(n*m); suggestion texts are short.
 */
export function diffBy<T>(A: T[], B: T[], key: (t: T) => string): { op: DiffOp["op"]; items: T[] }[] {
  const ka = A.map(key), kb = B.map(key);
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: { op: DiffOp["op"]; items: T[] }[] = [];
  const push = (op: DiffOp["op"], t: T) => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.items.push(t);
    else ops.push({ op, items: [t] });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { push("eq", B[j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push("del", A[i]); i++; }
    else { push("ins", B[j]); j++; }
  }
  while (i < n) { push("del", A[i]); i++; }
  while (j < m) { push("ins", B[j]); j++; }
  return ops;
}

/** Plain-text word diff. */
export function wordDiff(a: string, b: string): DiffOp[] {
  const id = (s: string) => s;
  return diffBy(tokenize(a), tokenize(b), id).map((o) => ({ op: o.op, text: o.items.join("") }));
}
