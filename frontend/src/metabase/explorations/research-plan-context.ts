import type { ExplorationBlock } from "metabase/explorations/hooks";
import type {
  ExplorationExploreFilter,
  ResearchPlanContext,
  ResearchPlanGroup,
  Timeline,
} from "metabase-types/api";

function filterLabel(filter: ExplorationExploreFilter): string {
  return filter.dimension_name
    ? `${filter.dimension_name}: ${filter.display_value}`
    : filter.display_value;
}

function blockToGroup(block: ExplorationBlock): ResearchPlanGroup {
  const filters = (block.exploreFilters ?? []).map(filterLabel);
  return {
    block_id: block.id,
    metric: { id: block.metric.id, name: block.metric.name },
    ...(filters.length > 0 ? { filters } : {}),
    dimensions: block.dimensions
      .filter((d) => block.selectedDimensionIds.has(d.id))
      .map((d) => ({ id: d.id, name: d.display_name })),
  };
}

/**
 * Serialize the in-progress draft Research plan into the shape Metabot reads from its chat
 * context. Plan-only: only the selected members of each block are included (the agent gets the
 * full catalog of candidates from `get_research_candidates`). The agent addresses blocks by the
 * stable `block_id`s emitted here.
 */
export function selectionToResearchPlanContext({
  blocks,
  timelines,
  name,
}: {
  blocks: ExplorationBlock[];
  timelines: Timeline[];
  name: string;
}): ResearchPlanContext {
  return {
    name,
    groups: blocks.map(blockToGroup),
    timelines: timelines.map((t) => ({ id: t.id, name: t.name })),
  };
}
