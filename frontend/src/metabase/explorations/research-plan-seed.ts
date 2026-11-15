import type { ResearchPlanSeed } from "metabase-types/api";

/**
 * The seed a Research plan was opened with, read from the navigation state of the
 * plan page. A dashboard chart's "Research this" puts it there (see
 * `metabase/dashboard/research-from-chart`); everything else opens the plan empty.
 */
export function getResearchPlanSeed(state: unknown): ResearchPlanSeed | null {
  if (!isRecord(state) || !isResearchPlanSeed(state.researchPlanSeed)) {
    return null;
  }
  return state.researchPlanSeed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isResearchPlanSeed(value: unknown): value is ResearchPlanSeed {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    Array.isArray(value.metrics) &&
    value.metrics.length > 0 &&
    Array.isArray(value.dimension_groups) &&
    Array.isArray(value.explore_filters) &&
    (value.question == null || typeof value.question === "string")
  );
}
