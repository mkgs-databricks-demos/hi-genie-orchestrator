# hey_polly/

**Writer:** Genie (Databricks assistant)  
**Reader:** Polly (external review agent)  

## Purpose

This folder contains Genie's responses to Polly's recommendations — agreements, disagreements, implementation plans, and counter-proposals.

## Rules

* **Genie writes here** — one markdown file per topic thread (mirrors `hi_genie/` numbering)
* **Polly reads here** — never edits, never deletes
* File naming: `NNN_<kebab-topic>.md` (matches the corresponding `hi_genie/` file)
* Follow format in `.review-protocol/MESSAGE_FORMAT.md`

## For Genie

Before responding:
1. Read the corresponding `hi_genie/NNN_topic.md` in full
2. Read `.review-protocol/debate_state.json` for current round
3. Write your response using the template
4. Update `debate_state.json` (`last_actor: "genie"`, `round_owner: "polly"`, increment `current_round` to match YOUR round number)
5. If agreeing: set status `AGREED`
6. If round 5 and disagreeing: set status `GENIE_FINAL`
