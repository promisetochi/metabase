import { useCallback } from "react";
import _ from "underscore";

import { usePrototypeStorage } from "metabase/metadata/prototype-storage";
import type { Field, FieldId, Table } from "metabase-types/api";
import { isObject } from "metabase-types/guards";

import {
  type MainDateInference,
  PERIOD_GRANULARITIES,
  type PeriodGranularity,
  type RoleInference,
  type RowIdentity,
  inferMainDate,
  inferPeriodGranularity,
  inferRowIdentity,
  inferTableRole,
} from "./inference";
import { type TableRole, isTableRole } from "./roles";

/** What an admin set; anything absent comes from sync's inference */
type TableStructureOverrides = {
  role?: TableRole;
  grainDescription?: string;
  periodGranularity?: PeriodGranularity;
  /** `null` means an admin said the table has no main date */
  mainDateFieldId?: FieldId | null;
};

type TableStructureState = {
  tables: Record<string, TableStructureOverrides>;
};

/** A table's structure as people see it: admin overrides over sync's inference */
export type TableStructure = {
  role: TableRole | null;
  inference: RoleInference;
  isRoleOverridden: boolean;
  grainDescription: string;
  rowIdentity: RowIdentity;
  periodGranularity: PeriodGranularity;
  /** `undefined` when the table has no main date */
  mainDateField: Field | undefined;
  mainDateInference: MainDateInference;
  isMainDateOverridden: boolean;
  mainDateNeedsReview: boolean;
};

// PROTOTYPE: mocked. There's no table_role or binding column yet, so
// admin overrides live in localStorage and the rest is inferred in the browser.
const STORAGE_KEY = "metabase-prototype-table-structure";

const parseFieldId = (value: unknown): FieldId | null | undefined =>
  value === null || typeof value === "number" ? value : undefined;

function parseOverrides(value: unknown): TableStructureOverrides {
  if (!isObject(value)) {
    return {};
  }
  const granularity = PERIOD_GRANULARITIES.find(
    (granularity) => granularity === value.periodGranularity,
  );
  return {
    role: isTableRole(value.role) ? value.role : undefined,
    grainDescription:
      typeof value.grainDescription === "string"
        ? value.grainDescription
        : undefined,
    periodGranularity: granularity,
    mainDateFieldId: parseFieldId(value.mainDateFieldId),
  };
}

function parseState(value: unknown): TableStructureState {
  if (!isObject(value)) {
    return { tables: {} };
  }
  const tables = isObject(value.tables)
    ? _.mapObject(value.tables, parseOverrides)
    : {};
  return { tables };
}

function getTableKey(table: Pick<Table, "db_id" | "id">) {
  return `${table.db_id}:${table.id}`;
}
/**
 * Every table's role and structure. Values an admin set win; the rest is
 * inferred from the table's keys, columns, and name.
 */
export function useTableStructures() {
  const [state, updateState] = usePrototypeStorage(STORAGE_KEY, parseState);

  const getTableStructure = useCallback(
    (table: Pick<Table, "db_id" | "id" | "name"> & { fields?: Field[] }) => {
      const fields = table.fields ?? [];
      const shape = { name: table.name, fields };
      const overrides = state.tables[getTableKey(table)] ?? {};
      const inference = inferTableRole(shape);
      const role = overrides.role ?? inference.role;
      const structure: TableStructure = {
        role,
        inference,
        isRoleOverridden: overrides.role != null,
        grainDescription: overrides.grainDescription ?? "",
        rowIdentity: inferRowIdentity(fields),
        periodGranularity:
          overrides.periodGranularity ?? inferPeriodGranularity(shape),
        ...resolveMainDate(fields, role, overrides.mainDateFieldId),
      };
      return structure;
    },
    [state],
  );

  const updateOverrides = useCallback(
    (
      table: Pick<Table, "db_id" | "id">,
      update: (overrides: TableStructureOverrides) => TableStructureOverrides,
    ) => {
      const tableKey = getTableKey(table);
      updateState((current) => ({
        ...current,
        tables: {
          ...current.tables,
          [tableKey]: update(current.tables[tableKey] ?? {}),
        },
      }));
    },
    [updateState],
  );

  /** `null` goes back to the inferred role */
  const setTableRole = useCallback(
    (table: Pick<Table, "db_id" | "id">, role: TableRole | null) =>
      updateOverrides(table, (overrides) => ({
        ...overrides,
        role: role ?? undefined,
      })),
    [updateOverrides],
  );

  const setGrainDescription = useCallback(
    (table: Pick<Table, "db_id" | "id">, grainDescription: string) =>
      updateOverrides(table, (overrides) => ({
        ...overrides,
        grainDescription: grainDescription || undefined,
      })),
    [updateOverrides],
  );

  const setPeriodGranularity = useCallback(
    (
      table: Pick<Table, "db_id" | "id">,
      periodGranularity: PeriodGranularity,
    ) =>
      updateOverrides(table, (overrides) => ({
        ...overrides,
        periodGranularity,
      })),
    [updateOverrides],
  );

  /** `undefined` goes back to the inferred main date; `null` sets none */
  const setMainDate = useCallback(
    (table: Pick<Table, "db_id" | "id">, fieldId: FieldId | null | undefined) =>
      updateOverrides(table, (overrides) => ({
        ...overrides,
        mainDateFieldId: fieldId,
      })),
    [updateOverrides],
  );

  return {
    getTableStructure,
    setTableRole,
    setGrainDescription,
    setPeriodGranularity,
    setMainDate,
  };
}

function resolveMainDate(
  fields: Field[],
  role: TableRole | null,
  overrideFieldId: FieldId | null | undefined,
): Pick<
  TableStructure,
  | "mainDateField"
  | "mainDateInference"
  | "isMainDateOverridden"
  | "mainDateNeedsReview"
> {
  const mainDateInference = inferMainDate(fields, role);
  const isMainDateOverridden = overrideFieldId !== undefined;
  const fieldId = isMainDateOverridden
    ? overrideFieldId
    : mainDateInference.fieldId;
  return {
    mainDateField: fields.find(
      (field) => fieldId != null && field.id === fieldId,
    ),
    mainDateInference,
    isMainDateOverridden,
    mainDateNeedsReview:
      !isMainDateOverridden && mainDateInference.confidence === "low",
  };
}
