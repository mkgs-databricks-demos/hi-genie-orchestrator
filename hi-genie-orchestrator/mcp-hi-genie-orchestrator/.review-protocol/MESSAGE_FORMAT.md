# Message Formats

Structured templates for Polly ↔ Genie communication.

---

## Polly → Genie (hi_genie/NNN_topic.md)

```markdown
# [TOPIC TITLE]

## Round N

**Date:** YYYY-MM-DD
**Type:** SUGGESTION | REQUIREMENT_UPDATE
**Priority:** LOW | MEDIUM | HIGH | CRITICAL

### References

| File | Location | Description |
| --- | --- | --- |
| `path/to/file.ts` | Lines 45-67, function `validateToken` | Current implementation |
| `path/to/spec.md` | Section "Authentication Flow" | Related requirement |

### Current State

[Brief description of what exists today]

### Recommendation

[What Polly recommends changing and why]

### Rationale

[Evidence, patterns, risks, or standards that justify this]

### Expected Impact

[What improves if adopted — performance, security, maintainability, etc.]
```

---

## Genie → Polly (hey_polly/NNN_topic.md)

```markdown
# Re: [TOPIC TITLE]

## Round N

**Date:** YYYY-MM-DD
**Verdict:** AGREE | DISAGREE

### Response

[Genie's assessment of the recommendation]

### If AGREE:

**Implementation Plan:**
- [ ] Step 1
- [ ] Step 2

**Timeline:** [When Genie plans to implement]

### If DISAGREE:

**Counter-Position:**
[Why Genie disagrees — must be substantive, not just "I prefer the current way"]

**Alternative (if any):**
[What Genie would do instead, if anything]
```

---

## Round Continuation (appended to existing file)

Both agents append rounds to their respective files. Never overwrite previous rounds — the full history must be preserved.

```markdown
---

## Round N

**Date:** YYYY-MM-DD
...
```

Use `---` (horizontal rule) to separate rounds visually.

---

## Resolution Footer (final round only)

Appended by whichever agent closes the debate:

```markdown
---

## Resolution

**Status:** AGREED | GENIE_FINAL
**Resolution:** CONSENSUS | GENIE_OVERRIDE
**Resolved At:** YYYY-MM-DDTHH:MM:SSZ
**Summary:** [One-sentence summary of the outcome]
```
