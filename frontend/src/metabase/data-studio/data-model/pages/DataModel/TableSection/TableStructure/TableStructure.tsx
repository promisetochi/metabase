import { useState } from "react";
import { t } from "ttag";

import {
  DetailsRow,
  DetailsTable,
  SidebarSection,
} from "metabase/common/components/DetailSidebar";
import {
  SettingsCard,
  SettingsRow,
} from "metabase/data-studio/common/components/SettingsSection";
import {
  type TableStructure as TableStructureValue,
  getPeriodGranularityOptions,
  getRowIdentityLabel,
  getTableRoleOptions,
  getTableRoleRowDescription,
  isRoleA,
  isTableRole,
  useTableStructures,
} from "metabase/metadata/table-structure";
import { Box, Select, TextInput } from "metabase/ui";
import { isDate } from "metabase-lib/v1/types/utils/isa";
import type { Field, FieldId, Table } from "metabase-types/api";

import {
  DETAILS_CELL_INPUT_CLASS_NAMES,
  DetailsEditableText,
} from "../../DetailPanel";

import S from "./TableStructure.module.css";

interface TableStructureProps {
  table: Table;
  readOnly: boolean;
}

/**
 * PROTOTYPE: mocked. A table's role and the structure it implies. Inferred in
 * the browser and overridable.
 */
export function TableStructure({
  table,
  readOnly,
  layout = "table",
}: TableStructureProps & {
  /** A details table for the drawer, or a settings card for a page */
  layout?: "table" | "form";
}) {
  const {
    getTableStructure,
    setTableRole,
    setGrainDescription,
    setPeriodGranularity,
    setMainDate,
  } = useTableStructures();
  const structure = getTableStructure(table);
  const fields = table.fields ?? [];
  const { role } = structure;
  if (layout === "form") {
    return (
      <Box className={S.structureSection}>
        <SettingsCard>
          <StructureFormRows
            table={table}
            structure={structure}
            readOnly={readOnly}
          />
        </SettingsCard>
      </Box>
    );
  }

  const structureTable = (
    <DetailsTable>
      <DetailsRow
        label={t`Role`}
        fillValue
        value={
          <RoleSelect
            structure={structure}
            disabled={readOnly}
            onChange={(role) => setTableRole(table, role)}
          />
        }
      />
      <DetailsRow
        label={t`Each row is`}
        fillValue
        value={
          <DetailsEditableText
            initialValue={structure.grainDescription}
            placeholder={
              role ? getTableRoleRowDescription(role) : t`Describe one row`
            }
            isMultiline
            isOptional
            isDisabled={readOnly}
            onChange={(value) => setGrainDescription(table, value.trim())}
            data-testid="table-grain-description-input"
          />
        }
      />
      <DetailsRow
        label={t`Row identity`}
        value={getRowIdentityLabel(structure.rowIdentity)}
      />
      <DetailsRow
        label={t`Main date`}
        fillValue
        value={
          <FieldSelect
            label={t`Main date`}
            fields={fields.filter((field) => isDate(field))}
            value={getMainDateFieldId(structure)}
            placeholder={t`No main date`}
            clearable
            disabled={readOnly}
            onChange={(fieldId) => setMainDate(table, fieldId)}
          />
        }
      />
      {role && isRoleA(role, "role/PeriodicSnapshotFact") && (
        <DetailsRow
          label={t`Period`}
          fillValue
          value={
            <Select
              aria-label={t`Period`}
              classNames={DETAILS_CELL_INPUT_CLASS_NAMES}
              data={getPeriodGranularityOptions()}
              value={structure.periodGranularity}
              allowDeselect={false}
              disabled={readOnly}
              onChange={(value) => {
                const option = getPeriodGranularityOptions().find(
                  (option) => option.value === value,
                );
                if (option) {
                  setPeriodGranularity(table, option.value);
                }
              }}
            />
          }
        />
      )}
    </DetailsTable>
  );

  return (
    <Box className={S.structureSection}>
      <SidebarSection title={t`Structure`}>{structureTable}</SidebarSection>
    </Box>
  );
}
type RoleInputProps = {
  structure: TableStructureValue;
  disabled: boolean;
  onChange: (role: TableStructureValue["role"]) => void;
};

function RoleSelect({ structure, disabled, onChange }: RoleInputProps) {
  return (
    <Select
      aria-label={t`Role`}
      classNames={DETAILS_CELL_INPUT_CLASS_NAMES}
      data={getTableRoleOptions()}
      value={structure.role}
      placeholder={t`Choose a role`}
      searchable
      allowDeselect={false}
      disabled={disabled}
      onChange={(value) => {
        if (isTableRole(value)) {
          onChange(value);
        }
      }}
      data-testid="table-role-select"
    />
  );
}

const toFieldOption = (field: Field) => ({
  value: String(field.id),
  label: field.display_name,
});

const toFieldValue = (fields: Field[], fieldId: FieldId | null) =>
  fields.some((field) => field.id === fieldId) ? String(fieldId) : null;

const toFieldId = (value: string | null) =>
  value != null ? Number(value) : null;

/**
 * The structure settings as rows of a page's settings card: no read-only
 * rows that the page already shows elsewhere
 */
function StructureFormRows({
  table,
  structure,
  readOnly,
}: {
  table: Table;
  structure: TableStructureValue;
  readOnly: boolean;
}) {
  const {
    setTableRole,
    setGrainDescription,
    setPeriodGranularity,
    setMainDate,
  } = useTableStructures();
  const fields = table.fields ?? [];
  const dateFields = fields.filter((field) => isDate(field));
  const { role } = structure;

  return (
    <>
      <SettingsRow label={t`Role`}>
        <Select
          aria-label={t`Role`}
          data={getTableRoleOptions()}
          value={role}
          placeholder={t`Choose a role`}
          searchable
          allowDeselect={false}
          disabled={readOnly}
          onChange={(value) => {
            if (isTableRole(value)) {
              setTableRole(table, value);
            }
          }}
        />
      </SettingsRow>
      <SettingsRow label={t`Each row is`}>
        <GrainDescriptionInput
          key={structure.grainDescription}
          value={structure.grainDescription}
          placeholder={
            role ? getTableRoleRowDescription(role) : t`Describe one row`
          }
          disabled={readOnly}
          onCommit={(value) => setGrainDescription(table, value)}
        />
      </SettingsRow>
      <SettingsRow label={t`Main date`}>
        <Select
          aria-label={t`Main date`}
          data={dateFields.map(toFieldOption)}
          value={toFieldValue(dateFields, getMainDateFieldId(structure))}
          placeholder={t`No main date`}
          clearable
          disabled={readOnly}
          onChange={(value) => setMainDate(table, toFieldId(value))}
        />
      </SettingsRow>
      {role && isRoleA(role, "role/PeriodicSnapshotFact") && (
        <SettingsRow label={t`Period`}>
          <Select
            aria-label={t`Period`}
            data={getPeriodGranularityOptions()}
            value={structure.periodGranularity}
            allowDeselect={false}
            disabled={readOnly}
            onChange={(value) => {
              const option = getPeriodGranularityOptions().find(
                (option) => option.value === value,
              );
              if (option) {
                setPeriodGranularity(table, option.value);
              }
            }}
          />
        </SettingsRow>
      )}
    </>
  );
}

/** Saves on blur or Enter */
function GrainDescriptionInput({
  value,
  placeholder,
  disabled,
  onCommit,
}: {
  value: string;
  placeholder: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <TextInput
      aria-label={t`Each row is`}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        if (draft.trim() !== value) {
          onCommit(draft.trim());
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function getMainDateFieldId({ mainDateField }: TableStructureValue) {
  return mainDateField ? mainDateField.id : null;
}

function FieldSelect({
  label,
  fields,
  value,
  placeholder = t`Choose a column`,
  clearable,
  disabled,
  onChange,
}: {
  label: string;
  fields: Field[];
  value: FieldId | null;
  placeholder?: string;
  clearable?: boolean;
  disabled: boolean;
  onChange: (fieldId: FieldId | null) => void;
}) {
  return (
    <Select
      aria-label={label}
      classNames={DETAILS_CELL_INPUT_CLASS_NAMES}
      data={fields.map(toFieldOption)}
      value={value != null ? String(value) : null}
      placeholder={placeholder}
      searchable
      clearable={clearable}
      allowDeselect={clearable}
      disabled={disabled}
      onChange={(value) => onChange(value != null ? Number(value) : null)}
    />
  );
}
