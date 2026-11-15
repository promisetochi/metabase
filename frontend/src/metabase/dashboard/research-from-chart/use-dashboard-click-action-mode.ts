import { useMemo } from "react";

import { canUserCreateQueries } from "metabase/current-user";
import {
  createDashboardClickActionMode,
  dashboardClickActionMode,
} from "metabase/dashboard/click-behavior/mode";
import { useGetUserMetabotPermissionsQuery } from "metabase/metabot/api";
import { useMetabotEnabledEmbeddingAware } from "metabase/metabot/hooks";
import { useSelector } from "metabase/redux";
import type { ClickActionsMode } from "metabase/visualizations/types";

import { getResearchClickActions } from "./research-click-action";
import type { ChartSeries } from "./utils";

/**
 * The click actions for a chart on a dashboard: the usual ones, plus "Research
 * this" for someone who may start a Research. Like the "New research" entry in the
 * command palette, that needs permission to create queries and to use Metabot's
 * natural language querying; without both the action is simply not offered.
 *
 * Metabot's permissions are only fetched when the action could be offered, so a
 * dashboard shown where it cannot (Metabot is off, the person cannot create
 * queries, or `skip` is set because the chart has its own click actions, as in an
 * embed) makes no extra request.
 */
export function useDashboardClickActionMode(
  series?: ChartSeries | null,
  { skip = false }: { skip?: boolean } = {},
): ClickActionsMode {
  const hasDataAccess = useSelector(canUserCreateQueries);
  const isMetabotEnabled = useMetabotEnabledEmbeddingAware({
    requireConfiguration: false,
  });
  const { data } = useGetUserMetabotPermissionsQuery(undefined, {
    skip: skip || !hasDataAccess || !isMetabotEnabled,
  });
  const hasNlqAccess =
    data?.permissions.metabot === "yes" &&
    data.permissions["metabot-nlq"] === "yes";
  const canResearch =
    !skip && hasDataAccess && isMetabotEnabled && hasNlqAccess;

  return useMemo(
    () =>
      canResearch
        ? createDashboardClickActionMode({
            mapActions: (actions, clicked, question) => [
              ...actions,
              ...getResearchClickActions({ clicked, question, series }),
            ],
          })
        : dashboardClickActionMode,
    [canResearch, series],
  );
}
