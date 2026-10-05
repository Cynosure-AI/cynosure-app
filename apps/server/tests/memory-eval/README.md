# Memory eval fixture

A fictional memory install for `memory:eval --dataset fixture`. Everything here is invented, so it can live in the repository and be shared.

- `corpus/` — 40 Markdown notes of "Lena Brandner", a freelance web developer in Graz, laid out like real memory folders (contacts, projects, personal, logs, recipes, hobbies, tech). Mostly German, some English.
- `dataset.json` — 146 hand-written questions with verbatim gold quotes.

The corpus deliberately contains what single-fact lookups miss:

| Case type | What it tests |
|---|---|
| `single`, `paraphrase`, `crosslang` | One fact, asked directly, reworded, or in the other language |
| `multi` | A chain across two notes (person → project → stack) |
| `aggregation` | Facts collected from three or four notes |
| `temporal` | A value later overridden by a log entry (rate, rent, employer, a debt) |
| `disambiguation` | Near-identical names (Sophie Lindner vs. Sophia Lindtner) |
| `noanswer` | Plausible questions the notes cannot answer, plus off-topic requests |

Three documents span several chunks, and their later sections avoid naming the subject ("der Kunde", "sie"). Contextual chunk summaries are meant to resolve exactly those.

## Usage

```
pnpm --filter cynosure-server memory:eval prepare --dataset fixture   # optional; run does it on demand
pnpm --filter cynosure-server memory:eval run --dataset fixture --conditions full,nograph,base,reranker
```

`prepare` indexes the corpus into `<data dir>/evals/memory/fixture/` with the app's own indexing and knowledge analysis, using the embedding and analysis models configured in the local install. The install is cached by corpus content and model settings.

## Editing

Every `gold[].quote` must appear verbatim in its file, apart from whitespace and Markdown emphasis. Changing a note can silently invalidate a question, so re-check quotes after edits. A `run` reports cases whose gold is never found under retrieval metrics, which is the first place a broken quote shows up.
