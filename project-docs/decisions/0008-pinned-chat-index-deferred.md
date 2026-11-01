# 0008 — Pinned-chat ordering is correct now, not yet indexed

**Context:** checkpoint 1.3 asks for "pinned chats and sensible ordering by
recent activity" in the chat list. That's `ORDER BY isPinned DESC,
lastMessageAt DESC, id DESC`. The composite index from checkpoint 1.1
(`@@index([userId, isDeleted, lastMessageAt(desc), id(desc)])`) doesn't
have `isPinned` as a leading column.

**Decision:** implement the ordering in the query now — correct today,
just a sequential sort instead of an index-order scan once a user has
enough chats for it to matter (not a concern at this trial's scale).
**Not** adding a migration for `@@index([userId, isDeleted,
isPinned(desc), lastMessageAt(desc), id(desc)])` without asking first,
per "do not change the database schema unless required by a concrete
API need" / "explain before implementing" — this is a performance
improvement, not a correctness requirement, so it's flagged here rather
than applied.

**Follow-up:** if/when this needs to be fast at real scale, add that
index in a migration — additive, safe, no data change.
