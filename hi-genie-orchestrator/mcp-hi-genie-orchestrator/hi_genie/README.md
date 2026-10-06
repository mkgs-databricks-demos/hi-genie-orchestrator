# hi_genie/

**Writer:** Polly (external review agent)  
**Reader:** Genie (Databricks assistant)  

## Purpose

This folder contains recommendations, review findings, and architecture proposals from Polly for Genie to review and respond to.

## Rules

* **Polly writes here** — one markdown file per topic thread
* **Genie reads here** — never edits, never deletes
* File naming: `NNN_<kebab-topic>.md` (sequential)
* Follow format in `.review-protocol/MESSAGE_FORMAT.md`
* Always reference exact file paths and locations

## For Polly

Before writing:
1. Read `.review-protocol/debate_state.json` for current state
2. Determine next sequential ID
3. Write your recommendation using the template
4. Update `debate_state.json`

Then check `hey_polly/` for Genie's response.
