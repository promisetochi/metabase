import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { useMetabotAgent } from "metabase/metabot/hooks";
import { Outlet, useLocation, useNavigationType } from "metabase/router";
import * as Urls from "metabase/urls";
import type { ResearchPlanSeed } from "metabase-types/api";

import { EXPLORATIONS_AGENT_ID } from "../components/NewExplorationChat/NewExplorationChat";
import { type ExplorationSelection, useExplorationSelection } from "../hooks";
import { getResearchPlanSeed } from "../research-plan-seed";
import { indexDimensionsById } from "../utils";

const NewExplorationDraftContext = createContext<ExplorationSelection | null>(
  null,
);

export function useNewExplorationDraft(): ExplorationSelection {
  const selection = useContext(NewExplorationDraftContext);
  if (!selection) {
    throw new Error(
      "useNewExplorationDraft must be used under the research route",
    );
  }
  return selection;
}

/**
 * Mounted on the parent `research` route, so one draft (selection +
 * conversation) spans the entry and plan pages and survives the navigation
 * between them, including browser back/forward. A fresh push to the entry URL
 * (+ New menu, "All projects") starts a new draft.
 */
export function NewExplorationDraftProvider(props: {
  // Rendered as an `element` route, so children come from <Outlet/>; the prop
  // stays for the unit test, which passes the pages in directly.
  children?: ReactNode;
}) {
  const { children = <Outlet /> } = props;
  const location = useLocation();
  const navigationType = useNavigationType();

  const [freshKey, setFreshKey] = useState(location.key);

  // Effect rather than render-time derivation: the draft keeps rendering for
  // one extra frame before the remount, which is invisible here.
  useEffect(() => {
    if (
      location.pathname === Urls.newExploration() &&
      navigationType !== "POP"
    ) {
      setFreshKey(location.key);
    }
  }, [location, navigationType]);

  return <NewExplorationDraft key={freshKey}>{children}</NewExplorationDraft>;
}

function NewExplorationDraft({ children }: { children?: ReactNode }) {
  const selection = useExplorationSelection();
  const { addMetric, setName } = selection;
  const location = useLocation();
  const seed = getResearchPlanSeed(location.state);
  const appliedSeed = useRef<ResearchPlanSeed | null>(null);

  // The question a chart opened the plan with, until it has been sent.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const hasBlocks = selection.blocks.length > 0;

  const { createNewConversation, submitInput } = useMetabotAgent(
    EXPLORATIONS_AGENT_ID,
  );

  useEffect(() => {
    createNewConversation();
  }, [createNewConversation]);

  // A plan opened from a dashboard chart starts with that chart's metric, scoped
  // to the clicked point, and no dimensions picked: Metabot chooses them from the
  // question. Declared after the effect above, which clears the conversation, so
  // it runs after it.
  useEffect(() => {
    if (seed == null || appliedSeed.current === seed) {
      return;
    }
    appliedSeed.current = seed;
    const dimensionsById = indexDimensionsById(seed.dimension_groups);
    for (const metric of seed.metrics) {
      addMetric(metric, {
        dimensionsById,
        exploreFilters: seed.explore_filters,
        // Without a question there is nothing for Metabot to choose from (and no
        // Metabot at all when no AI provider is set up), so keep the defaults.
        withoutDefaultDimensions: seed.question != null,
      });
    }
    setName(seed.name);
    setPendingQuestion(seed.question);
  }, [seed, addMetric, setName]);

  // The question is sent in a later render than the one that adds the block: the
  // send goes to the conversation of the render it runs in, which has to be the
  // new one, and Metabot reads the plan as it is then, which has to include the
  // block.
  useEffect(() => {
    if (pendingQuestion == null || !hasBlocks) {
      return;
    }
    setPendingQuestion(null);
    submitInput(pendingQuestion, {
      preventOpenSidebar: true,
      profile: "explorations",
    });
  }, [pendingQuestion, hasBlocks, submitInput]);

  return (
    <NewExplorationDraftContext.Provider value={selection}>
      {children}
    </NewExplorationDraftContext.Provider>
  );
}
