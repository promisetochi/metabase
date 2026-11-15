import { createMockMetadata } from "__support__/metadata";
import type { ClickObject } from "metabase/visualizations/types";
import Question from "metabase-lib/v1/Question";
import type { DatasetColumn } from "metabase-types/api";
import {
  createMockCard,
  createMockColumn,
  createMockDatetimeColumn,
} from "metabase-types/api/mocks";
import {
  ORDERS_ID,
  SAMPLE_DB_ID,
  createSampleDatabase,
} from "metabase-types/api/mocks/presets";

import {
  buildDefaultQuestion,
  getActiveDashboardFilters,
  getClickedPoint,
  getResearchFilters,
  getResearchableCardId,
  isPointClick,
} from "./utils";

const METADATA = createMockMetadata({ databases: [createSampleDatabase()] });

const category: DatasetColumn = createMockColumn({
  name: "CATEGORY",
  display_name: "Category",
  base_type: "type/Text",
  effective_type: "type/Text",
  field_ref: ["field", 1, null],
});

const createdAt: DatasetColumn = createMockDatetimeColumn({
  name: "CREATED_AT",
  display_name: "Created At",
  unit: "month",
  field_ref: ["field", 2, { "temporal-unit": "month" }],
});

const revenue: DatasetColumn = createMockColumn({
  name: "sum",
  display_name: "Sum of Total",
  source: "aggregation",
  base_type: "type/Float",
  effective_type: "type/Float",
});

function savedQuestion({
  display = "bar",
  aggregations = [["sum", ["field", 1, null]]],
  stages = 1,
  type = "question",
}: {
  display?: string;
  aggregations?: unknown[];
  stages?: number;
  type?: "question" | "model" | "metric";
} = {}) {
  const query = {
    "source-table": ORDERS_ID,
    aggregation: aggregations,
    breakout: [["field", 1, null]],
  };
  const dataset_query = {
    type: "query" as const,
    database: SAMPLE_DB_ID,
    // A second stage nests the first as a source query.
    query: stages === 1 ? query : { "source-query": query },
  };
  return new Question(
    // The queries are built loosely to cover shapes the card types do not allow, such as a second stage.
    createMockCard({ id: 7, type, display, dataset_query } as never),
    METADATA,
  );
}

describe("getResearchableCardId", () => {
  it("offers a saved chart with a breakdown and one aggregation", () => {
    expect(getResearchableCardId(savedQuestion())).toBe(7);
  });

  it("offers a line chart, which is a breakdown over time", () => {
    expect(getResearchableCardId(savedQuestion({ display: "line" }))).toBe(7);
  });

  it("does not offer a table, which has no point to start from", () => {
    expect(
      getResearchableCardId(savedQuestion({ display: "table" })),
    ).toBeNull();
  });

  it("does not offer a chart with several aggregations", () => {
    const question = savedQuestion({
      aggregations: [["count"], ["sum", ["field", 1, null]]],
    });
    expect(getResearchableCardId(question)).toBeNull();
  });

  it("does not offer a chart that summarizes in two stages", () => {
    expect(getResearchableCardId(savedQuestion({ stages: 2 }))).toBeNull();
  });

  it("does not offer a model", () => {
    expect(getResearchableCardId(savedQuestion({ type: "model" }))).toBeNull();
  });

  it("does not offer a generated x-ray card, whose id is not a saved card's", () => {
    // An x-ray card's id is a string, which the mock's type does not allow.
    const card = createMockCard({ id: "G__322599", display: "bar" } as never);
    expect(getResearchableCardId(new Question(card, METADATA))).toBeNull();
  });

  it("does not offer a question that is not saved", () => {
    // A card that was never saved has no id, which the mock's type does not allow.
    const card = createMockCard({ id: undefined, display: "bar" } as never);
    expect(getResearchableCardId(new Question(card, METADATA))).toBeNull();
  });
});

describe("isPointClick", () => {
  it("is true for a click on a point of a breakdown", () => {
    expect(
      isPointClick({ dimensions: [{ column: category, value: "Gadget" }] }),
    ).toBe(true);
  });

  it("is false without a clicked dimension, and for a brush", () => {
    expect(isPointClick({})).toBe(false);
    expect(
      isPointClick({
        dimensions: [{ column: createdAt, value: "2026-01-01" }],
        column: createdAt,
        event: new MouseEvent("mouseup"),
        brushRange: {
          type: "temporal",
          start: "2026-01-01",
          end: "2026-02-01",
        },
      }),
    ).toBe(false);
  });
});

describe("getResearchFilters", () => {
  it("scopes to the clicked category", () => {
    const clicked: ClickObject = {
      dimensions: [{ column: category, value: "Gadget" }],
    };
    expect(getResearchFilters(clicked)).toEqual([
      {
        operator: "=",
        field_ref: ["field", 1, null],
        value: "Gadget",
        display_value: "Gadget",
        dimension_name: "Category",
      },
    ]);
  });

  it("leaves a date out, so the date range around the point stays", () => {
    const clicked: ClickObject = {
      dimensions: [
        { column: createdAt, value: "2026-05-01T00:00:00Z" },
        { column: category, value: "Gadget" },
      ],
    };
    expect(getResearchFilters(clicked).map((f) => f.field_ref)).toEqual([
      ["field", 1, null],
    ]);
  });
});

describe("getClickedPoint", () => {
  const rows = [
    ["2026-03-01", 100],
    ["2026-04-01", 120],
    ["2026-05-01", 180],
  ];
  const series = [
    {
      data: {
        cols: [createdAt, revenue],
        rows,
      },
    },
  ];
  const clicked: ClickObject = {
    dimensions: [{ column: createdAt, value: "2026-05-01" }],
    data: [
      { col: createdAt, value: "2026-05-01" },
      { col: revenue, value: 180 },
    ],
    // A line chart's click carries no `origin`, so the row is found by its values.
  };

  it("reads the point and the one before it from the chart's rows", () => {
    const point = getClickedPoint(
      clicked,
      savedQuestion({ display: "line" }),
      series,
    );
    expect(point).toMatchObject({
      measure: "Sum of Total",
      value: 180,
      isPeriod: true,
      previous: { value: 120 },
    });
  });

  it("compares with the point before it on the same line when there is a line per category", () => {
    const multiRows = [
      ["2026-04-01", "Gadget", 10],
      ["2026-04-01", "Widget", 500],
      ["2026-05-01", "Gadget", 20],
      ["2026-05-01", "Widget", 400],
    ];
    const multiSeries = [
      { data: { cols: [createdAt, category, revenue], rows: multiRows } },
    ];
    const point = getClickedPoint(
      {
        dimensions: [
          { column: category, value: "Widget" },
          { column: createdAt, value: "2026-05-01" },
        ],
        data: [{ col: revenue, value: 400 }],
      },
      savedQuestion({ display: "line" }),
      multiSeries,
    );
    expect(point).toMatchObject({
      isPeriod: true,
      value: 400,
      previous: { value: 500 },
    });
  });

  it("finds the row when the clicked date has a time and the row has only the day", () => {
    const point = getClickedPoint(
      {
        dimensions: [{ column: createdAt, value: "2026-05-01T00:00:00" }],
        data: [{ col: revenue, value: 180 }],
      },
      savedQuestion({ display: "line" }),
      series,
    );
    expect(point).toMatchObject({ previous: { value: 120 } });
  });

  it("does not take a category for another that starts with the same text", () => {
    const rowsByName = [
      ["Gadget Pro", 900],
      ["Gadget", 100],
    ];
    const point = getClickedPoint(
      {
        dimensions: [{ column: category, value: "Gadget" }],
        data: [{ col: revenue, value: 100 }],
      },
      savedQuestion(),
      [{ data: { cols: [category, revenue], rows: rowsByName } }],
    );
    // the mean of the others is the one other category, not zero of them
    expect(point?.meanOfOthers).toBe(900);
  });

  it("works from the click alone when there are no rows", () => {
    const point = getClickedPoint(clicked, savedQuestion({ display: "line" }));
    expect(point).toMatchObject({ value: 180, previous: null });
  });
});

describe("buildDefaultQuestion", () => {
  const base = {
    measure: "Sum of Total",
    value: 180,
    label: "May 2026",
    dimension: "Created At",
    isPeriod: true,
    previous: { label: "April 2026", value: 120 },
    meanOfOthers: null,
  };

  it("asks why a period rose, with the change", () => {
    expect(buildDefaultQuestion(base)).toBe(
      "Why did Sum of Total rise 50% in May 2026 compared with April 2026?",
    );
  });

  it("asks why a period fell", () => {
    const question = buildDefaultQuestion({
      ...base,
      value: 60,
      previous: { label: "April 2026", value: 120 },
    });
    expect(question).toBe(
      "Why did Sum of Total fall 50% in May 2026 compared with April 2026?",
    );
  });

  it("asks what drove a period that barely changed", () => {
    const question = buildDefaultQuestion({
      ...base,
      value: 121,
      previous: { label: "April 2026", value: 120 },
    });
    expect(question).toBe("What drove Sum of Total in May 2026?");
  });

  it("asks what drove a period with nothing before it", () => {
    expect(buildDefaultQuestion({ ...base, previous: null })).toBe(
      "What drove Sum of Total in May 2026?",
    );
  });

  describe("for a category", () => {
    const point = {
      measure: "Sum of Total",
      value: 300,
      label: "Gadget",
      dimension: "Category",
      isPeriod: false,
      previous: null,
      meanOfOthers: 100,
    };

    it("asks why it is higher than the others", () => {
      expect(buildDefaultQuestion(point)).toBe(
        "Why is Sum of Total higher for Gadget than for other Category values?",
      );
    });

    it("asks why it is lower than the others", () => {
      expect(buildDefaultQuestion({ ...point, value: 40 })).toBe(
        "Why is Sum of Total lower for Gadget than for other Category values?",
      );
    });

    it("asks what drives it when it is close to the others", () => {
      expect(buildDefaultQuestion({ ...point, value: 101 })).toBe(
        "What drives Sum of Total for Category Gadget?",
      );
    });
  });
});

describe("getActiveDashboardFilters", () => {
  const parameters = [
    { id: "p1", name: "Region", slug: "region" },
    { id: "p2", name: "Plan", slug: "plan" },
    { id: "p3", name: "Quarter", slug: "quarter" },
  ];

  it("lists the filters that are set and mapped to the chart", () => {
    const extraData = {
      parameters,
      parameterValuesBySlug: { region: ["EMEA", "APAC"], plan: "Pro" },
      dashcard: {
        parameter_mappings: [{ parameter_id: "p1" }, { parameter_id: "p2" }],
      },
    };
    expect(getActiveDashboardFilters(extraData)).toEqual([
      "Region: EMEA, APAC",
      "Plan: Pro",
    ]);
  });

  it("skips a filter that is empty or not mapped to this chart", () => {
    const extraData = {
      parameters,
      parameterValuesBySlug: { region: [], plan: "Pro", quarter: "Q3" },
      dashcard: {
        parameter_mappings: [{ parameter_id: "p1" }, { parameter_id: "p2" }],
      },
    };
    expect(getActiveDashboardFilters(extraData)).toEqual(["Plan: Pro"]);
  });

  it("returns nothing when the click carries no dashboard", () => {
    expect(getActiveDashboardFilters(undefined)).toEqual([]);
    expect(getActiveDashboardFilters({})).toEqual([]);
  });
});
