# Memory retrieval evaluation

Create a JSON dataset containing representative queries and the source files that contain their evidence:

```json
[
  {
    "query": "Which database powers semantic memory?",
    "relevantSourceFiles": ["memory-architecture.md"],
    "spaceId": "default"
  },
  {
    "query": "zxqv blorptastic unrelated nonsense",
    "expectNoAnswer": true,
    "spaceId": "default"
  }
]
```

With the server running, execute:

```bash
pnpm --filter cynosure-server memory:evaluate ./memory-evaluation.json http://127.0.0.1:3099 20
```

The command reports source-level recall, mean reciprocal rank, the no-answer false-positive rate, and failed cases. Keep separate development and held-out datasets. Tune chunking, candidate counts, models, and reranker thresholds on the development set; use the held-out set only to verify the chosen configuration.
