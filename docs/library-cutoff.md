# Library: meaning cut-off calibration

Vector search (kNN) always returns neighbours, even for a question none of the notes answers. The
library therefore drops vector hits by cosine distance (sqlite-vec `distance_metric=cosine`,
0 = same direction, 2 = opposite). Keyword (FTS5/BM25) hits are never affected.

Two cut-offs apply to every vector hit:

- **absolute** `max`: distance must be ≤ max;
- **relative** `rel`: distance must be ≤ best vector hit + rel (drops the tail behind a clear match).

## Settings (Settings → Library)

| Setting | Default | Meaning |
|---|---|---|
| Per-model cut-offs | empty | one line per model: `model = max [rel]`, e.g. `nomic-embed-text = 0.4 0.05`; `bge-* = 0.5` matches by prefix; `#` starts a comment |
| Meaning match cut-off for all models | 0 | absolute cut-off for models without a line; 0 = built-in per-model default |

Order: per-model line → global value → built-in table (`MODEL_CUTOFFS` in
`src/plugins/builtin/library/runtime.ts`). A missing relative value falls back to the built-in one.

| Model | max | rel | Source |
|---|---|---|---|
| `nomic-embed-text` (any tag/alias containing it) | 0.40 | 0.05 | calibrated (below) |
| anything else | 0.80 | 0.15 | loose default, not calibrated |

## Calibration (nomic-embed-text v1.5, Q4_K_M, llama.cpp b11724, 2026-10-19)

`scripts/calibrate-cutoff.mjs` indexes `tests/fixtures/library-calib.json` (20 short personal notes →
26 chunks, the real Rust chunker via `kb-cli`) and embeds with the same `search_document:` /
`search_query:` prefixes as the app. 21 questions have a labelled relevant note; 10 have none.

```
llama-server -m nomic-embed-text-v1.5.Q4_K_M.gguf --embedding --pooling mean -c 2048 -ub 2048 --port 11434 --alias nomic-embed-text
(cd src-tauri && cargo build --release --bin kb-cli)
EMBED_URL=http://127.0.0.1:11434/v1 EMBED_MODEL=nomic-embed-text node scripts/calibrate-cutoff.mjs
```

Distances seen:

- relevant note (best chunk): 0.13–0.38 (median ≈ 0.30);
- best hit of a question with no relevant note: 0.40–0.52;
- English question → Chinese note (`notes/学习.md`): 0.49, below an unrelated English note (0.37).
  nomic-embed-text is English-centric; cross-language matches need a looser per-model line.

Grid (pass = vector hit kept; "noise" = irrelevant chunks kept):

| max | rel | relevant kept | noise on relevant questions | hits on no-match questions |
|---|---|---|---|---|
| 0.38 | 0.05 | 20/21 | 3 | 0 |
| **0.40** | **0.05** | **20/21** | **5** | **0** |
| 0.40 | off | 20/21 | 11 | 0 |
| 0.42 | 0.05 | 20/21 | 7 | 2 |
| 0.45 | 0.05 | 20/21 | 7 | 11 |
| 0.50 | off | 21/21 | 201 | 51 |
| 0.80 (old) | off | 21/21 | 512 | 260 |

Through the Rust search (k = 10, meaning only): old 0.8 → 176 irrelevant hits on relevant questions
and 100 hits on no-match questions; new 0.40 / 0.05 → 5 and 0, with 20/21 relevant notes found
(the miss is the cross-language one). 0.40 sits between the weakest relevant match (0.375) and the
closest unrelated best hit (0.404); the margin is small, so the setting stays tunable.

Re-run the script for another model (`EMBED_MODEL=…`, any OpenAI-compatible `/v1/embeddings`) and
add a line in Settings → Library, or a row in `MODEL_CUTOFFS`.

"Related to this note" (mean of the note's vectors vs. other notes) is not cut off; it always lists
the nearest notes.
