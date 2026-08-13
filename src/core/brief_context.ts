/**
 * Re-export shim. The implementation moved to
 * src/core/domain_packs/life_context.ts during the Durable-Truth Phase 1
 * generalization (2026-05-30); `pull_brief_context` is now the
 * `life_context` domain pack. This shim keeps legacy importers
 * (scripts/smoke-weather-brief.ts and any external callers) working
 * without churn. New code should import from '@core/domain_packs'.
 */
export * from './domain_packs/life_context';
