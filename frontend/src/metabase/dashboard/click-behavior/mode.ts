import { Mode } from "metabase/querying/click-actions/Mode";
import { getQueryMode } from "metabase/querying/click-actions/lib/modes";
import { DefaultMode } from "metabase/querying/click-actions/modes/DefaultMode";
import type { QueryClickActionsMode } from "metabase/querying/click-actions/types";
import type { ClickActionsMode } from "metabase/visualizations/types";
import type Question from "metabase-lib/v1/Question";

import { DashboardClickAction } from "./DashboardClickAction";

const DashboardDefaultMode: QueryClickActionsMode = {
  ...DefaultMode,
  clickActions: [...DefaultMode.clickActions, DashboardClickAction],
};

function getDashboardQueryMode(question: Question): QueryClickActionsMode {
  const mode = getQueryMode(question);
  return mode === DefaultMode ? DashboardDefaultMode : mode;
}

/**
 * The click actions for a chart on a dashboard. `mapActions` can add to or change
 * the actions of a click, for example to offer one more.
 */
export function createDashboardClickActionMode(
  options?: ConstructorParameters<typeof Mode>[1],
): ClickActionsMode {
  return new Mode(getDashboardQueryMode, options);
}

export const dashboardClickActionMode: ClickActionsMode =
  createDashboardClickActionMode();
