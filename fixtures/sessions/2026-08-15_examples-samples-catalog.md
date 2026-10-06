# Session: Replace Examples with samples.* Catalog Projects

**Date:** 2026-08-15  
**Branch:** `mg-genie-integration-test-readiness`  
**Duration:** ~25 min  

## Problem

Original 4 example projects (data-platform-migration, ml-model-deployment, customer-360, compliance-automation) required external systems (Snowflake, Salesforce, Stripe, etc.) that don't exist in the workspace. Not runnable without infrastructure provisioning.

## Solution

Replaced with 3 projects built entirely on `samples.*` catalog data — zero external dependencies, all executable from a single workspace.

## Approach

1. Explored `samples` catalog: 7 schemas (accuweather, bakehouse, databricks, healthverity, nyctaxi, sec, tpcds_sf1/sf1000, tpch, wanderbricks)
2. Evaluated each for richness, component coverage, and complementary strengths
3. Selected 3 datasets that collectively demonstrate every platform capability
4. Designed each with all 7 required components: SDP, semantic layer, AI/BI dashboard, Genie Space, AI Search/ML model, Lakebase, branded app

## New Examples

### 1. WanderBricks Travel Intelligence (samples.wanderbricks)
* **Tables:** 16 (richest dataset — bookings, properties, reviews, clickstream, support, destinations)
* **AI capability:** Vector Search (semantic property/destination/review search)
* **SDP highlights:** AUTO CDC on booking_updates, streaming clickstream sessionization
* **Theme:** Sunset orange + ocean blue (warm, travel-inspired)
* **Unique:** Nested types (support messages), CDC, rich text for embeddings

### 2. Bakehouse Franchise Analytics (samples.bakehouse)
* **Tables:** 6 (manageable scope — transactions, customers, franchises, suppliers, reviews)
* **AI capability:** XGBoost demand forecasting per franchise per product
* **SDP highlights:** `ai_classify()` for review sentiment, streaming transactions
* **Theme:** Golden amber + espresso (warm bakery)
* **Unique:** PII in customer data (compliance demo), multi-location comparison

### 3. CityPulse Urban Mobility (samples.nyctaxi + samples.accuweather)
* **Tables:** 2 core + 4 weather variants (cross-catalog join)
* **AI capability:** Weather-aware demand prediction (XGBoost, 50+ weather features)
* **SDP highlights:** Cross-catalog fusion, weather feature engineering, surge detection
* **Theme:** Dark charcoal + electric cyan (urban ops center, dark mode)
* **Unique:** Cross-domain data fusion, what-if surge simulator

## Files Modified/Created

**Deleted (9 files):**
* `examples/data-platform-migration/` (README.md + architecture/requirements.md)
* `examples/ml-model-deployment/` (README.md + architecture/requirements.md)
* `examples/customer-360/` (README.md + architecture/requirements.md)
* `examples/compliance-automation/` (README.md + architecture/requirements.md)
* Old `examples/README.md` (replaced)

**Created (7 files):**
* `examples/README.md` — Index with comparison table, coverage matrix, execution order
* `examples/wanderbricks-travel-intelligence/README.md` — Overview + DAG + branding
* `examples/wanderbricks-travel-intelligence/architecture/requirements.md` — Full 7-component spec
* `examples/bakehouse-franchise-analytics/README.md` — Overview + DAG + branding
* `examples/bakehouse-franchise-analytics/architecture/requirements.md` — Full 7-component spec
* `examples/citypulse-urban-mobility/README.md` — Overview + DAG + branding
* `examples/citypulse-urban-mobility/architecture/requirements.md` — Full 7-component spec

## Design Decisions

| Decision | Rationale |
| --- | --- |
| 3 examples instead of 4 | Each is richer (7 components vs 1-2); quality over quantity |
| All from samples.* | Zero external deps = actually runnable as integration tests |
| One AI Search + Two ML models | Shows both capability paths; WanderBricks has rich text, others have numeric prediction targets |
| Each has distinct visual theme | Demonstrates branding customization (light/light/dark) |
| Recommended order: Bakehouse → CityPulse → WanderBricks | Increasing complexity for progressive learning |
| Every project has same DAG shape | pipeline → [semantic + ML/search + lakebase] → [dashboard + genie] → app |

## Key Observation

`samples.wanderbricks` is remarkably complete — 16 tables with CDC (booking_updates), streaming events (clickstream), rich text (descriptions, reviews, support messages with sentiment), nested structs, and geographic data. It alone could demo the entire platform.

## Commit

```
feat: replace examples with 3 full-stack projects from samples catalog
```

15 files (9 deleted + 7 created - 1 replaced = 15 total changes)
