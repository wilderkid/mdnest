// Word-level LCS diff. Used by suggestions to show pending text without writing it into the document.
// Tokens are words (including CJK characters) kept together with the whitespace that follows them,
// so a join of every token reconstructs the input.

export type DiffOp = { op: "eq" | "ins" | "del"; text: string };

export function tokenize(s: string): string[] {
  return s.match(/\s+|\S+/g) ?? [];
}

/** Longest-common-subsequence word diff. O(n*m); suggestion texts are short. */
export function wordDiff(a: string, b: string): DiffOp[] {
  const A = tokenize(a), B = tokenize(b);
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  const push = (op: DiffOp["op"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.text += text;
    else ops.push({ op, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push("eq", A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push("del", A[i]); i++; }
    else { push("ins", B[j]); j++; }
  }
  while (i < n) { push("del", A[i]); i++; }
  while (j < m) { push("ins", B[j]); j++; }
  return ops;
}
