import { useState } from "react";
import { t } from "ttag";

import {
  useGetResearchFromChartPreviewQuery,
  usePrepareResearchFromChartMutation,
} from "metabase/api";
import { useToast } from "metabase/common/hooks";
import { useUserMetabotPermissions } from "metabase/metabot/hooks";
import { useNavigate } from "metabase/router";
import {
  Box,
  Button,
  Group,
  Loader,
  Radio,
  Stack,
  Text,
  Textarea,
} from "metabase/ui";
import * as Urls from "metabase/urls";
import type {
  CardId,
  ExplorationExploreFilter,
  ResearchFromChartIneligibleReason,
  ResearchFromChartPreview,
  ResearchMetricMatch,
  ResearchPlanSeed,
} from "metabase-types/api";

export type ResearchFromChartPopoverProps = {
  cardId: CardId;
  /** The chart's name, which names the Research. */
  chartName: string;
  /** The question to start from; the person can edit it. */
  defaultQuestion: string;
  /** Scope the Research to the clicked point. */
  filters: ExplorationExploreFilter[];
  /** Dashboard filters set on this chart, which a Research does not apply. */
  dashboardFilters: string[];
  onClose: () => void;
};

/** "Create a metric from this chart" in the choice of metrics. */
const CREATE_NEW = "new";

function getIneligibleMessage(reason: ResearchFromChartIneligibleReason) {
  switch (reason) {
    case "native":
      return t`This chart comes from a SQL question, so it can't be researched yet.`;
    case "aggregation-count":
      return t`This chart shows more than one number, so it can't be researched yet.`;
    case "multi-stage":
      return t`This chart summarizes data more than once, so it can't be researched yet.`;
    case "model":
      return t`This chart shows a model, so it can't be researched.`;
    case "not-a-metric":
      return t`This chart can't be turned into a metric, so it can't be researched.`;
  }
}

function getResearchName(chartName: string) {
  return chartName.length > 0 ? t`Research: ${chartName}` : t`Research`;
}

function metricLabel(metric: ResearchMetricMatch) {
  return metric.in_library ? t`${metric.name} (Library)` : metric.name;
}

function getMetricSummary(
  preview: Extract<ResearchFromChartPreview, { eligible: true }>,
) {
  if (preview.metric != null) {
    const name = preview.metric.name;
    return t`This will research the metric "${name}".`;
  }
  if (preview.exact != null) {
    const name = preview.exact.name;
    return t`This chart matches the metric "${name}", so that metric will be used.`;
  }
  return t`A metric will be saved to your personal collection from this chart so Research can slice it.`;
}

export function ResearchFromChartPopover({
  cardId,
  chartName,
  defaultQuestion,
  filters,
  dashboardFilters,
  onClose,
}: ResearchFromChartPopoverProps) {
  const navigate = useNavigate();
  const [sendToast] = useToast();
  // The question only orders the charts by relevance, which is done by the AI.
  const { canUseNlq } = useUserMetabotPermissions();

  const {
    data: preview,
    isLoading,
    error,
  } = useGetResearchFromChartPreviewQuery(cardId);
  const [prepareResearch, { isLoading: isPreparing }] =
    usePrepareResearchFromChartMutation();

  const [question, setQuestion] = useState(defaultQuestion);
  const [choice, setChoice] = useState(CREATE_NEW);

  // Nothing is started here: the person lands on the Research plan, where they
  // can ask more, change what is researched, and start it themselves.
  const handlePlan = async () => {
    const metricId = choice === CREATE_NEW ? null : Number(choice);
    const trimmed = question.trim();
    const { data, error: prepareError } = await prepareResearch({
      card_id: cardId,
      metric_id: metricId,
    });
    if (prepareError != null || data == null) {
      sendToast({
        variant: "negative",
        message: t`Failed to prepare the research plan`,
      });
      return;
    }
    const seed: ResearchPlanSeed = {
      ...data,
      name: getResearchName(chartName),
      explore_filters: filters,
      question: canUseNlq && trimmed.length > 0 ? trimmed : null,
    };
    onClose();
    navigate(Urls.newExplorationPlan(), { state: { researchPlanSeed: seed } });
  };

  if (isLoading) {
    return (
      <Box p="lg" data-testid="research-from-chart-loading">
        <Loader size="sm" />
      </Box>
    );
  }

  if (error != null || preview == null) {
    return (
      <Box p="lg" maw="22rem">
        <Text>{t`Couldn't check this chart. Try again in a moment.`}</Text>
      </Box>
    );
  }

  if (!preview.eligible) {
    return (
      <Box p="lg" maw="22rem">
        <Text>{getIneligibleMessage(preview.reason)}</Text>
      </Box>
    );
  }

  const filtersText = dashboardFilters.join("; ");
  const similar = preview.similar ?? [];
  const showChoice =
    preview.metric == null && preview.exact == null && similar.length > 0;

  return (
    <Stack
      p="lg"
      gap="md"
      w="26rem"
      maw="100%"
      data-testid="research-from-chart"
    >
      <Text fw="bold">{t`Research this`}</Text>

      {canUseNlq && (
        <Textarea
          label={t`What do you want to find out?`}
          value={question}
          onChange={(event) => setQuestion(event.currentTarget.value)}
          autosize
          minRows={2}
          maxRows={6}
        />
      )}

      {showChoice ? (
        <Radio.Group value={choice} onChange={setChoice}>
          <Stack gap="xs">
            <Radio
              value={CREATE_NEW}
              label={t`Save a new metric from this chart`}
            />
            {similar.map((metric) => {
              const name = metricLabel(metric);
              return (
                <Radio
                  key={metric.id}
                  value={String(metric.id)}
                  label={t`Use the existing metric ${name}`}
                />
              );
            })}
          </Stack>
        </Radio.Group>
      ) : (
        <Text c="text-secondary" size="sm">
          {getMetricSummary(preview)}
        </Text>
      )}

      {dashboardFilters.length > 0 && (
        <Text c="text-secondary" size="sm">
          {t`This dashboard is filtered (${filtersText}). Research looks at all of the data, so those filters are not applied.`}
        </Text>
      )}

      <Group justify="flex-end" gap="sm">
        <Button variant="subtle" onClick={onClose}>{t`Cancel`}</Button>
        <Button variant="filled" loading={isPreparing} onClick={handlePlan}>
          {t`Plan research`}
        </Button>
      </Group>
    </Stack>
  );
}
