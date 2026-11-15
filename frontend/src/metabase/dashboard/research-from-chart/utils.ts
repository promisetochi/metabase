import { t } from "ttag";

import { formatValue } from "metabase/value-formatting";
import * as Lib from "metabase-lib";
import type Question from "metabase-lib/v1/Question";
import { isDate } from "metabase-lib/v1/types/utils/isa";
import type {
  CardId,
  DatasetColumn,
  ExplorationExploreFilter,
  RowValue,
} from "metabase-types/api";

/** The part of a chart's series this reads: the rows behind the chart. */
export type ChartSeries = ReadonlyArray<{
  data?: { cols: DatasetColumn[]; rows: RowValue[][] } | null;
}>;

import type { ClickObject } from "metabase/visualizations/types";
import { isBrushClickObject } from "metabase/visualizations/types";

/**
 * Chart types where a click lands on one point of a breakdown, which is what a
 * Research starts from. Tables, scalars and maps are left out.
 */
const RESEARCHABLE_DISPLAYS = new Set([
  "bar",
  "row",
  "line",
  "area",
  "combo",
  "pie",
  "waterfall",
]);

/**
 * The saved card behind a chart when a Research can start from it, otherwise
 * null. This is a cheap look at the chart's shape so the action is not offered
 * where it cannot work; the server makes the final call
 * (`GET /api/exploration/from-card/:card-id`): a metric has a single stage and
 * exactly one aggregation, and a SQL question or a model has none to lift out.
 */
export function getResearchableCardId(question: Question): CardId | null {
  const cardId = question.id();
  // An x-ray dashboard's cards are generated on the fly and carry a made-up
  // string id, so only a numeric id names a card the server can find.
  if (
    typeof cardId !== "number" ||
    !question.isSaved() ||
    question.isNative() ||
    question.type() === "model" ||
    !RESEARCHABLE_DISPLAYS.has(question.display())
  ) {
    return null;
  }

  const query = question.query();
  if (Lib.stageCount(query) !== 1 || Lib.aggregations(query, -1).length !== 1) {
    return null;
  }
  return cardId;
}

/** A click on a point of a chart, as opposed to a brush over a range. */
export function isPointClick(clicked: ClickObject): boolean {
  return !isBrushClickObject(clicked) && (clicked.dimensions?.length ?? 0) > 0;
}

function isTemporalColumn(column: DatasetColumn): boolean {
  return isDate(column);
}

function formatClickedValue(value: RowValue, column: DatasetColumn): string {
  return String(formatValue(value, { column }));
}

/**
 * Filters that scope a Research to the clicked point: one equality per clicked
 * category. A date is left out on purpose. "Why did sales jump last week" needs
 * the weeks around it as well, so the whole date range stays and the period goes
 * into the question instead.
 */
export function getResearchFilters(
  clicked: ClickObject,
): ExplorationExploreFilter[] {
  return (clicked.dimensions ?? []).flatMap(({ column, value }) =>
    column.field_ref != null && !isTemporalColumn(column)
      ? [
          {
            operator: "=" as const,
            field_ref: column.field_ref,
            value,
            display_value: formatClickedValue(value, column),
            dimension_name: column.display_name,
          },
        ]
      : [],
  );
}

type ClickedPoint = {
  /** What is being measured, for example "Sum of Total". */
  measure: string;
  value: number | null;
  /** The clicked category or period, for example "Gadget" or "May 2026". */
  label: string;
  /** What the points are broken out by, for example "Category". */
  dimension: string;
  isPeriod: boolean;
  /** The measure at the previous and next point, when the chart has rows to look at. */
  previous: { label: string; value: number } | null;
  /** The measure's mean over every other point. */
  meanOfOthers: number | null;
};

function toNumber(value: RowValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Whether a row's value is the clicked value. A clicked date can be written with a
 * time ("2028-01-01T00:00:00") where the row has only the day ("2028-01-01"), so
 * the shorter of two texts only has to be the start of the longer.
 */
function isSameValue(
  rowValue: RowValue,
  clickedValue: RowValue,
  column: DatasetColumn,
): boolean {
  const a = String(rowValue);
  const b = String(clickedValue);
  if (a === b) {
    return true;
  }
  // Only for dates: as text, "Gadget" is the start of "Gadget Pro".
  return (
    isTemporalColumn(column) &&
    a.length > 0 &&
    b.length > 0 &&
    (a.startsWith(b) || b.startsWith(a))
  );
}

/** What was clicked and what is around it, read from the clicked row and the chart's rows. */
export function getClickedPoint(
  clicked: ClickObject,
  question: Question,
  series?: ChartSeries | null,
): ClickedPoint | null {
  const clickedDimensions = clicked.dimensions ?? [];
  // A chart over time with a series per category is clicked at a date and a
  // category: the date is what the question is about.
  const dimension =
    clickedDimensions.find(({ column }) => isTemporalColumn(column)) ??
    clickedDimensions[0];
  if (dimension == null) {
    return null;
  }
  // What tells the point's own line apart from the others on the chart.
  const seriesDimensions = clickedDimensions.filter((d) => d !== dimension);

  const measureEntry = clicked.data?.find(
    (entry) => entry.col?.source === "aggregation",
  );
  const measure =
    measureEntry?.col?.display_name ?? question.displayName() ?? t`the value`;
  const label = formatClickedValue(dimension.value, dimension.column);
  const isPeriod = isTemporalColumn(dimension.column);

  const data = series?.[0]?.data;
  let previous: ClickedPoint["previous"] = null;
  let meanOfOthers: number | null = null;

  if (data != null && measureEntry?.col != null) {
    const measureName = measureEntry.col.name;
    const measureIndex = data.cols.findIndex((c) => c.name === measureName);
    const dimensionIndex = data.cols.findIndex(
      (c) => c.name === dimension.column.name,
    );
    // The click does not say which row it is on (a line chart's does not), so the
    // row is found by its values. Only the rows of the clicked series count, so the
    // point before it is on the same line.
    const isOnSeries = (row: RowValue[]) =>
      seriesDimensions.every(({ column, value }) => {
        const index = data.cols.findIndex((c) => c.name === column.name);
        return index >= 0 && isSameValue(row[index], value, column);
      });
    const seriesRows = data.rows.filter(isOnSeries);
    const position = seriesRows.findIndex((row) =>
      isSameValue(row[dimensionIndex], dimension.value, dimension.column),
    );

    if (measureIndex >= 0 && dimensionIndex >= 0 && position >= 0) {
      const before = seriesRows[position - 1];
      const beforeValue = toNumber(before?.[measureIndex]);
      if (before != null && beforeValue != null) {
        previous = {
          label: formatClickedValue(before[dimensionIndex], dimension.column),
          value: beforeValue,
        };
      }
      const others = seriesRows
        .filter((_, index) => index !== position)
        .map((row) => toNumber(row[measureIndex]))
        .filter((value): value is number => value != null);
      if (others.length > 0) {
        meanOfOthers = others.reduce((sum, v) => sum + v, 0) / others.length;
      }
    }
  }

  return {
    measure,
    value: toNumber(measureEntry?.value),
    label,
    dimension: dimension.column.display_name,
    isPeriod,
    previous,
    meanOfOthers,
  };
}

/** A change smaller than this is not worth calling a rise or a fall. */
const NOTABLE_CHANGE = 0.05;

function percentChange(from: number, to: number): number | null {
  return from === 0 ? null : (to - from) / Math.abs(from);
}

/**
 * The question to start from, built from the clicked point and the points around
 * it with a fixed template, not an LLM, so it works without an AI provider and
 * cannot invent facts. The person edits it before starting.
 */
export function buildDefaultQuestion(point: ClickedPoint): string {
  const { measure, value, label, dimension, isPeriod, previous } = point;
  const previousLabel = previous?.label ?? "";
  let question: string;

  const change =
    isPeriod && previous != null && value != null
      ? percentChange(previous.value, value)
      : null;

  if (isPeriod) {
    if (change != null && Math.abs(change) >= NOTABLE_CHANGE) {
      const percent = Math.round(Math.abs(change) * 100);
      question =
        change > 0
          ? t`Why did ${measure} rise ${percent}% in ${label} compared with ${previousLabel}?`
          : t`Why did ${measure} fall ${percent}% in ${label} compared with ${previousLabel}?`;
    } else {
      question = t`What drove ${measure} in ${label}?`;
    }
  } else if (
    value != null &&
    point.meanOfOthers != null &&
    point.meanOfOthers !== 0 &&
    Math.abs(percentChange(point.meanOfOthers, value) ?? 0) >= NOTABLE_CHANGE
  ) {
    question =
      value > point.meanOfOthers
        ? t`Why is ${measure} higher for ${label} than for other ${dimension} values?`
        : t`Why is ${measure} lower for ${label} than for other ${dimension} values?`;
  } else {
    question = t`What drives ${measure} for ${dimension} ${label}?`;
  }

  return question;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The dashboard filters that are set and apply to this chart, as short texts such
 * as "Category: Gadget". A Research does not apply them (it reads the metric's own
 * data), so the question mentions them and the popover says so.
 *
 * The click carries the dashboard's state as loose `extraData`, so each piece is
 * checked before it is used.
 */
export function getActiveDashboardFilters(
  extraData: Record<string, unknown> | undefined,
): string[] {
  const valuesBySlug = extraData?.parameterValuesBySlug;
  const values = isRecord(valuesBySlug) ? valuesBySlug : {};
  const dashcard = extraData?.dashcard;
  const mappings = isRecord(dashcard)
    ? asArray(dashcard.parameter_mappings)
    : [];
  const mapped = new Set(
    mappings.flatMap((mapping) =>
      isRecord(mapping) && typeof mapping.parameter_id === "string"
        ? [mapping.parameter_id]
        : [],
    ),
  );

  return asArray(extraData?.parameters).flatMap((parameter) => {
    if (
      !isRecord(parameter) ||
      typeof parameter.id !== "string" ||
      typeof parameter.name !== "string" ||
      typeof parameter.slug !== "string" ||
      !mapped.has(parameter.id)
    ) {
      return [];
    }
    const value = values[parameter.slug];
    const isEmpty =
      value == null || (Array.isArray(value) && value.length === 0);
    if (isEmpty) {
      return [];
    }
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    return [`${parameter.name}: ${text}`];
  });
}
