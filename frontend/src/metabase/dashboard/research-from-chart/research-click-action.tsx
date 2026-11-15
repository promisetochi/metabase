import { t } from "ttag";

import type {
  ClickAction,
  ClickActionPopoverProps,
  ClickObject,
} from "metabase/visualizations/types";
import type Question from "metabase-lib/v1/Question";

import { ResearchFromChartPopover } from "./ResearchFromChartPopover";
import {
  type ChartSeries,
  buildDefaultQuestion,
  getActiveDashboardFilters,
  getClickedPoint,
  getResearchFilters,
  getResearchableCardId,
  isPointClick,
} from "./utils";

/**
 * The "Research this" action on a point of a dashboard chart. It opens a small
 * form to start a Research from the chart, so a viewer does not have to know what
 * a metric is: the metric is derived from the chart on the server.
 *
 * Returns nothing for a chart that cannot be researched (see
 * [[getResearchableCardId]]) and for clicks that are not on a point.
 */
export function getResearchClickActions({
  clicked,
  question,
  series,
}: {
  clicked: ClickObject;
  question: Question;
  series?: ChartSeries | null;
}): ClickAction[] {
  const cardId = getResearchableCardId(question);
  if (cardId == null || !isPointClick(clicked)) {
    return [];
  }

  const dashboardFilters = getActiveDashboardFilters(clicked.extraData);
  const point = getClickedPoint(clicked, question, series);
  const defaultQuestion = point != null ? buildDefaultQuestion(point) : "";
  const filters = getResearchFilters(clicked);

  const Popover = ({ onClose }: ClickActionPopoverProps) => (
    <ResearchFromChartPopover
      cardId={cardId}
      chartName={question.displayName() ?? ""}
      defaultQuestion={defaultQuestion}
      filters={filters}
      dashboardFilters={dashboardFilters}
      onClose={onClose}
    />
  );

  return [
    {
      name: "research-this",
      section: "custom",
      title: t`Research this`,
      buttonType: "horizontal",
      icon: "telescope",
      popover: Popover,
    },
  ];
}
