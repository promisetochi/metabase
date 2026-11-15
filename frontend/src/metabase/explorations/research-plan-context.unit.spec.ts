import type {
  ExplorationExploreFilter,
  ExplorationMetric,
  MetricDimension,
  Timeline,
} from "metabase-types/api";
import { createMockMetric } from "metabase-types/api/mocks/metric";
import { createMockTimeline } from "metabase-types/api/mocks/timeline";

import { selectionToResearchPlanContext } from "./research-plan-context";
import { mockExplorationBlock } from "./test-utils";

function metric(id: number, name: string): ExplorationMetric {
  // Unjustified type cast. FIXME
  return createMockMetric({ id, name }) as ExplorationMetric;
}

function dimension(
  id: string,
  opts?: Partial<MetricDimension>,
): MetricDimension {
  return {
    id,
    name: id,
    display_name: id,
    effective_type: "type/Text",
    semantic_type: null,
    ...opts,
  };
}

describe("selectionToResearchPlanContext", () => {
  it("serializes a block with only selected dimensions", () => {
    const region = dimension("d1", { display_name: "Region" });
    const plan = dimension("d2", { display_name: "Plan" });
    const block = mockExplorationBlock(
      metric(42, "Revenue"),
      [region, plan],
      new Set(["d1"]), // only Region selected
    );

    const result = selectionToResearchPlanContext({
      blocks: [block],
      timelines: [],
      name: "Why was revenue down?",
    });

    expect(result.name).toBe("Why was revenue down?");
    expect(result.groups).toEqual([
      {
        block_id: "metric:42",
        metric: { id: 42, name: "Revenue" },
        dimensions: [{ id: "d1", name: "Region" }],
      },
    ]);
  });

  it("says what a group is limited to, and nothing for a group that is not", () => {
    const region = dimension("d1", { display_name: "Region" });
    const exploreFilters: ExplorationExploreFilter[] = [
      {
        operator: "=",
        field_ref: ["field", 1, null],
        value: "Gadget",
        display_value: "Gadget",
        dimension_name: "Category",
      },
    ];
    const limited = {
      ...mockExplorationBlock(metric(42, "Revenue"), [region], new Set()),
      exploreFilters,
    };
    const plain = mockExplorationBlock(metric(43, "Churn"), [region]);

    const result = selectionToResearchPlanContext({
      blocks: [limited, plain],
      timelines: [],
      name: "",
    });

    expect(result.groups[0]).toEqual({
      block_id: "metric:42",
      metric: { id: 42, name: "Revenue" },
      filters: ["Category: Gadget"],
      dimensions: [],
    });
    expect(result.groups[1]).not.toHaveProperty("filters");
  });

  it("includes selected timelines", () => {
    const timelines: Timeline[] = [
      createMockTimeline({ id: 1, name: "Releases" }),
      createMockTimeline({ id: 2, name: "Campaigns" }),
    ];

    const result = selectionToResearchPlanContext({
      blocks: [],
      timelines,
      name: "",
    });

    expect(result.timelines).toEqual([
      { id: 1, name: "Releases" },
      { id: 2, name: "Campaigns" },
    ]);
  });

  it("produces an empty plan for an empty selection", () => {
    expect(
      selectionToResearchPlanContext({ blocks: [], timelines: [], name: "" }),
    ).toEqual({ name: "", groups: [], timelines: [] });
  });
});
