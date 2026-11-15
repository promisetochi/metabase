import { getResearchPlanSeed } from "./research-plan-seed";

const seed = {
  name: "Research: Orders by category",
  metrics: [{ id: 1, name: "Number of Orders" }],
  dimension_groups: [],
  explore_filters: [],
  question: "What drives orders?",
};

describe("getResearchPlanSeed", () => {
  it("reads the seed from the navigation state", () => {
    expect(getResearchPlanSeed({ researchPlanSeed: seed })).toBe(seed);
  });

  it("accepts a seed without a question", () => {
    const withoutQuestion = { ...seed, question: null };
    expect(getResearchPlanSeed({ researchPlanSeed: withoutQuestion })).toBe(
      withoutQuestion,
    );
  });

  it("is null when the plan was not opened from a chart", () => {
    expect(getResearchPlanSeed(null)).toBeNull();
    expect(getResearchPlanSeed(undefined)).toBeNull();
    expect(getResearchPlanSeed({})).toBeNull();
    expect(getResearchPlanSeed("seed")).toBeNull();
  });

  it("ignores a seed that is missing what the plan needs", () => {
    expect(
      getResearchPlanSeed({ researchPlanSeed: { ...seed, metrics: [] } }),
    ).toBeNull();
    expect(
      getResearchPlanSeed({
        researchPlanSeed: { ...seed, dimension_groups: undefined },
      }),
    ).toBeNull();
    expect(
      getResearchPlanSeed({ researchPlanSeed: { ...seed, question: 5 } }),
    ).toBeNull();
  });
});
