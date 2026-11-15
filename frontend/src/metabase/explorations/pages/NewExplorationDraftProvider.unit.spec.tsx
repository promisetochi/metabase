import fetchMock from "fetch-mock";
import { useState } from "react";

import { act, renderWithProviders, screen, waitFor } from "__support__/ui";
import type { ExplorationSelection } from "metabase/explorations/hooks";
import {
  makeMockSelection,
  mockExplorationBlock,
} from "metabase/explorations/test-utils";
import {
  getMessages,
  getMetabotConversationId,
  metabotActions,
} from "metabase/metabot/state";
import { Navigate, Route } from "metabase/router";
import type { ExplorationExploreFilter } from "metabase-types/api";
import { createMockMetric } from "metabase-types/api/mocks";

import { NewExplorationDraftProvider } from "./NewExplorationDraftProvider";
import { NewExplorationPage } from "./NewExplorationPage";
import { NewExplorationPlanPage } from "./NewExplorationPlanPage";

const mockRendered: {
  entry?: ExplorationSelection;
  plan?: ExplorationSelection;
} = {};

jest.mock("../hooks", () => ({
  useExplorationSelection: jest.fn(),
}));

jest.mock("../components/NewExplorationChat/NewExplorationChat", () => ({
  EXPLORATIONS_AGENT_ID: "explorations",
  NewExplorationChat: () => null,
}));

jest.mock("../components/NewExplorationEntry", () => ({
  NewExplorationEntry: ({ selection }: { selection: ExplorationSelection }) => {
    mockRendered.entry = selection;
    return null;
  },
}));

jest.mock("../components/NewExplorationPlan", () => ({
  NewExplorationPlan: ({ selection }: { selection: ExplorationSelection }) => {
    mockRendered.plan = selection;
    return null;
  },
}));

const exploreFilters: ExplorationExploreFilter[] = [
  {
    operator: "=",
    field_ref: ["field", 1, null],
    value: "Gadget",
    display_value: "Gadget",
  },
];

const seed = {
  name: "Research: Orders by category",
  // the mock only builds the base metric; a seed carries the Research one
  metrics: [
    { ...createMockMetric({ id: 5, name: "Orders" }), dimension_ids: [] },
  ],
  dimension_groups: [],
  explore_filters: exploreFilters,
  question: "What drives Number of Orders for Category Gadget?",
};

function setup({
  withBlock = false,
  question = seed.question,
}: {
  // The mocked selection never grows, so a test that needs the seed's block to
  // be in the plan starts the draft with it.
  withBlock?: boolean;
  question?: string | null;
} = {}) {
  const { useExplorationSelection } = jest.requireMock("../hooks");
  // like the real hook: one identity per mounted instance, new one on remount
  jest.mocked(useExplorationSelection).mockImplementation(() => {
    const [selection] = useState(() =>
      makeMockSelection({
        blocks: withBlock ? [mockExplorationBlock(seed.metrics[0])] : [],
      }),
    );
    return selection;
  });

  const { router, store } = renderWithProviders(
    // mirrors the prod route structure: the provider wraps only the
    // entry + plan routes, not the `:id` detail routes
    <Route path="/question/research">
      <Route element={<NewExplorationDraftProvider />}>
        <Route index element={<NewExplorationPage />} />
        <Route path="plan" element={<NewExplorationPlanPage />} />
      </Route>
      <Route
        path="from-chart"
        element={
          <Navigate
            to="/question/research/plan"
            state={{ researchPlanSeed: { ...seed, question } }}
            replace
          />
        }
      />
      <Route path=":id" element={<div data-testid="detail-page" />} />
    </Route>,
    {
      withRouter: true,
      initialRoute: "/question/research",
    },
  );

  const draftConversationId = () =>
    getMetabotConversationId(store.getState(), "explorations");

  // stand-in for the request "Create plan" fires just before navigating
  const submitDraftMessage = () =>
    act(() => {
      store.dispatch(
        metabotActions.addUserMessage({
          conversationId: draftConversationId(),
          id: "draft-1",
          type: "text",
          message: "Why are signups down?",
        }),
      );
    });

  const getDraftMessages = () =>
    getMessages(store.getState(), draftConversationId());

  return {
    router,
    submitDraftMessage,
    getDraftMessages,
    useExplorationSelection: jest.mocked(useExplorationSelection),
  };
}

describe("NewExplorationDraftProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete mockRendered.entry;
    delete mockRendered.plan;
  });

  it("keeps one draft and conversation across the plan step and browser back/forward (UXW-4832)", () => {
    const { router, submitDraftMessage, getDraftMessages } = setup();

    submitDraftMessage();
    act(() => {
      router?.navigate("/question/research/plan");
    });

    // shared draft, and no conversation reset that would cancel the agent run
    // Create plan just started
    const shared = mockRendered.entry;
    expect(mockRendered.plan).toBe(shared);
    expect(getDraftMessages()).toHaveLength(1);

    act(() => {
      router?.back();
    });
    act(() => {
      router?.forward();
    });

    expect(mockRendered.entry).toBe(shared);
    expect(mockRendered.plan).toBe(shared);
    expect(getDraftMessages()).toHaveLength(1);
  });

  it("starts the plan with the metric, scope and name a chart opened it with, and no dimensions picked", () => {
    const { router, getDraftMessages } = setup();

    // what a dashboard chart's "Research this" does: a link to the plan page
    // that carries the seed in the navigation state
    act(() => {
      router?.navigate("/question/research/from-chart");
    });

    const draft = mockRendered.plan;
    expect(draft?.addMetric).toHaveBeenCalledTimes(1);
    expect(draft?.addMetric).toHaveBeenCalledWith(
      seed.metrics[0],
      expect.objectContaining({
        exploreFilters,
        withoutDefaultDimensions: true,
      }),
    );
    expect(draft?.setName).toHaveBeenCalledWith(seed.name);
    // the question waits for the block, so Metabot sees the plan it is asked about
    expect(getDraftMessages()).toHaveLength(0);
  });

  it("sends the question to Metabot once the block is in the plan", async () => {
    fetchMock.post("path:/api/metabot/agent-streaming", 200);
    const { router, getDraftMessages } = setup({ withBlock: true });

    act(() => {
      router?.navigate("/question/research/from-chart");
    });

    const sentByUser = () =>
      getDraftMessages().filter((message) => message.role === "user");
    await waitFor(() => expect(sentByUser()).toHaveLength(1));
    expect(JSON.stringify(sentByUser()[0])).toContain(seed.question);
    // the request carries it too, as the first message of the conversation
    await waitFor(() =>
      expect(
        fetchMock.callHistory.calls("path:/api/metabot/agent-streaming"),
      ).toHaveLength(1),
    );
  });

  it("sends nothing when the chart opened the plan without a question", () => {
    const { router, getDraftMessages } = setup({
      withBlock: true,
      question: null,
    });

    act(() => {
      router?.navigate("/question/research/from-chart");
    });

    expect(getDraftMessages()).toHaveLength(0);
  });

  it("keeps the default dimensions when there is no question for Metabot to choose from", () => {
    const { router } = setup({ question: null });

    act(() => {
      router?.navigate("/question/research/from-chart");
    });

    expect(mockRendered.plan?.addMetric).toHaveBeenCalledWith(
      seed.metrics[0],
      expect.objectContaining({ withoutDefaultDimensions: false }),
    );
  });

  it("opens the plan empty when it was not opened from a chart", () => {
    const { router } = setup();

    act(() => {
      router?.navigate("/question/research/plan");
    });

    expect(mockRendered.plan?.addMetric).not.toHaveBeenCalled();
    expect(mockRendered.plan?.setName).not.toHaveBeenCalled();
  });

  it("does not mount the draft on the exploration detail routes", () => {
    const {
      router,
      submitDraftMessage,
      getDraftMessages,
      useExplorationSelection,
    } = setup();

    submitDraftMessage();
    useExplorationSelection.mockClear();

    act(() => {
      router?.navigate("/question/research/123");
    });

    expect(screen.getByTestId("detail-page")).toBeInTheDocument();
    expect(useExplorationSelection).not.toHaveBeenCalled();
    expect(getDraftMessages()).toHaveLength(1);
  });

  it("starts a fresh draft and conversation on an explicit new visit to the entry page", () => {
    const { router, submitDraftMessage, getDraftMessages } = setup();

    submitDraftMessage();
    act(() => {
      router?.navigate("/question/research/plan");
    });
    const shared = mockRendered.plan;

    // what the "All projects" link does
    act(() => {
      router?.navigate("/question/research");
    });

    expect(mockRendered.entry).not.toBe(shared);
    expect(getDraftMessages()).toHaveLength(0);
  });
});
