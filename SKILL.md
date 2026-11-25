---
name: gorge-free-research
description: Free keyless topic research for Arabic video scripts using Wikipedia and DuckDuckGo, with relevance filtering and honest caveats.
---

# Gorge Free Research

Use `researchTopic(topic)` from `src/providers.ts`. It tries a configured research API,
then Arabic Wikipedia, then DuckDuckGo. Results are normalised (Arabic diacritics,
tatweel, alef/ya variants), scored against the topic tokens, and returned with caveats.

No paid API and no API key required.
