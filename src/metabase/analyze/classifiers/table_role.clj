(ns metabase.analyze.classifiers.table-role
  "Classifier that proposes a Table's role, i.e. how the table is built: a fact, a dimension, a bridge, and so on.
  Roles are the `:role/*` keywords in `metabase.types.core/table-role-hierarchy`.

  Nothing calls this during sync and nothing stores its result yet: the next step is a nullable `table_role` column
  on `metabase_table`, with a twin in `metabase_table_user_settings` so an admin's choice wins over sync."
  (:refer-clojure :exclude [some every?])
  (:require
   [metabase.analyze.schema :as analyze.schema]
   [metabase.util :as u]
   [metabase.util.i18n :refer [tru]]
   [metabase.util.malli :as mu]
   [metabase.util.performance :refer [some every?]]))

(def ^:private MinimalField
  "The keys of a Field this classifier reads, as hand-built maps (e.g. in tests) pass them."
  [:map {:closed true}
   [:name                                :string]
   [:base_type          {:optional true} [:maybe :keyword]]
   [:effective_type     {:optional true} [:maybe :keyword]]
   [:semantic_type      {:optional true} [:maybe :keyword]]
   [:database_is_pk     {:optional true} [:maybe :boolean]]
   [:fk_target_field_id {:optional true} [:maybe pos-int?]]])

(def ^:private Field
  [:or analyze.schema/Field MinimalField])

(def ^:private RoleInference
  [:map {:closed true}
   [:role       [:and :keyword [:fn {:error/message "a :role/* keyword"} #(= "role" (namespace %))]]]
   [:signal     :string]
   [:confidence [:enum :high :low]]])

(def ^:private index-pattern        #"(?:^|_)(?:index|idx|position|pos|seq|sequence|ordinal)$")
(def ^:private version-pattern      #"(?:^|_)version$")
(def ^:private valid-from-pattern   #"(?:^|_)(?:valid_from|effective_from|effective_date|dbt_valid_from)$|^_fivetran_start$")
(def ^:private valid-to-pattern     #"(?:^|_)(?:valid_to|effective_to|end_date|dbt_valid_to)$|^_fivetran_end$")
(def ^:private created-pattern      #"^(?:created_at|created|created_on|inserted_at)$")
(def ^:private updated-pattern      #"^(?:updated_at|updated|updated_on|modified_at|last_modified)$")
(def ^:private label-pattern        #"^(?:name|label|code|title|description|display_name)$")
(def ^:private property-pattern     #"(?:^|_)(?:property|attribute|key|field|name)(?:_name|_key|_id)?$")
(def ^:private value-pattern        #"(?:^|_)value$")
(def ^:private definition-label-patterns [#"^title$" #"^label$" #"^display_name$" #"^name$"])
(def ^:private definition-type-pattern #"^(?:type|data_type|field_type|value_type)$")
(def ^:private status-pattern       #"(?:^|_)(?:status|stage|phase|result|outcome)$")
;; `state` is as often an address as a lifecycle state, so it only counts on text columns
(def ^:private state-pattern        #"(?:^|_)state$")
(def ^:private milestone-pattern    #"^(?:[a-z]+ed|paid|sent|won|lost|begun|done)_(?:at|on|date|time)$")
(def ^:private bookkeeping-pattern
  #"^(?:created|updated|modified|deleted|inserted|loaded|synced|extracted|ingested|processed|refreshed)_")

(def ^:private name-rules
  "Tuples of `[table-name-pattern role confidence]`, tried in order. Warehouse prefixes are strong signals."
  [[#"^(?:_fivetran|fivetran_|dbt_)|_audit$"                                 :role/SystemTable          :high]
   [#"^(?:dim_|d_)"                                                         :role/EntityDimension      :high]
   [#"^(?:fct_|fact_|f_)"                                                   :role/TransactionFact      :high]
   [#"^agg_"                                                                :role/AggregateFact        :high]
   [#"^hub_"                                                                :role/Hub                  :high]
   [#"^sat_"                                                                :role/Satellite            :high]
   [#"^(?:lnk_|link_)"                                                      :role/Link                 :high]
   [#"_(?:history|snapshots?|versions?)$"                                   :role/HistoryDimension     :low]
   [#"_(?:summary|totals|rollup)$"                                          :role/AggregateFact        :low]
   [#"_(?:report|daily|weekly|monthly|stats)$"                              :role/PeriodicSnapshotFact :low]
   [#"_(?:translations?|i18n|locales?)$"                                    :role/TranslationTable     :low]
   [#"custom_fields?|property_values?|_properties$"                         :role/CustomPropertyTable  :low]
   [#"(?:^|_)(?:settings|config|configuration|preferences)$"                :role/ConfigurationTable   :low]
   [#"(?:^|_)(?:events?|logs?|checkins?|clicks?|pageviews?|activit(?:y|ies))$" :role/EventFact        :low]
   [#"(?:^|_)(?:orders?|order_lines?|transactions?|sales?|payments?|invoices?)$" :role/TransactionFact :low]
   [#"(?:^|_)(?:users?|accounts?|people|persons?|customers?|employees?|products?|companies|company|vendors?|deals?|tickets?)$"
    :role/EntityDimension :low]
   [#"(?:^|_)(?:types|statuses|categories|codes)$"                          :role/LookupDimension      :low]])

(defn- field-name [field]
  (u/lower-case-en (:name field)))

(defn- named? [pattern field]
  (boolean (re-find pattern (field-name field))))

(defn- semantic-type-isa? [field ancestor]
  (isa? (:semantic_type field) ancestor))

(defn- data-type-isa? [field ancestor]
  (isa? (or (:effective_type field) (:base_type field)) ancestor))

(defn- pk? [field]
  (or (:database_is_pk field) (semantic-type-isa? field :type/PK)))

(defn- fk? [field]
  (or (semantic-type-isa? field :type/FK) (some? (:fk_target_field_id field))))

(defn- temporal? [field]
  (data-type-isa? field :type/Temporal))

(defn- status? [field]
  (and (not (temporal? field))
       (not (data-type-isa? field :type/Boolean))
       (not (semantic-type-isa? field :type/State))
       (or (semantic-type-isa? field :type/Status)
           (and (or (data-type-isa? field :type/Text) (data-type-isa? field :type/Number))
                (named? status-pattern field))
           (and (data-type-isa? field :type/Text)
                (named? state-pattern field)))))

(defn- milestone? [field]
  (and (temporal? field)
       (named? milestone-pattern field)
       (not (named? bookkeeping-pattern field))))

(defn- valid-from? [field]
  (or (semantic-type-isa? field :type/ValidFrom) (named? valid-from-pattern field)))

(defn- valid-to? [field]
  (or (semantic-type-isa? field :type/ValidTo) (named? valid-to-pattern field)))

(defn- inference [role signal confidence]
  {:role role, :signal signal, :confidence confidence})

(defn- infer-from-keys [fields]
  (let [pks (filter pk? fields)
        fks (filter fk? fields)]
    (or (when (and (>= (count fks) 2)
                   (every? #(or (pk? %) (fk? %)) fields))
          (inference :role/Bridge (tru "every column is a key, linking {0} tables" (count fks)) :high))
        (when-let [index-key (when (= (count fks) 1)
                               (some #(when (named? index-pattern %) %) pks))]
          (inference :role/ArrayChild
                     (tru "its key is {0} plus the position {1}" (:name (first fks)) (:name index-key))
                     :high))
        (when (>= (count pks) 2)
          (let [date-key (some #(when (temporal? %) %) pks)]
            (or (when (and date-key
                           (every? #(or (identical? % date-key) (fk? %)) pks))
                  (inference :role/PeriodicSnapshotFact
                             (tru "its key is the date {0} plus foreign keys" (:name date-key))
                             :high))
                (when-let [version-key (or date-key (some #(when (named? version-pattern %) %) pks))]
                  (inference :role/HistoryDimension
                             (tru "its key is an ID plus {0}" (:name version-key))
                             :high))))))))

(defn- first-matching [patterns fields]
  (some (fn [pattern]
          (some #(when (named? pattern %) %) fields))
        patterns))

(defn- infer-custom-property-role [fields]
  (let [value-field    (some #(when (named? value-pattern %) %) fields)
        property-field (some #(when (and (not (pk? %)) (named? property-pattern %)) %) fields)
        entity-key     (some #(when (and (fk? %) (not (identical? % property-field))) %) fields)
        label-field    (first-matching definition-label-patterns fields)
        type-field     (some #(when (named? definition-type-pattern %) %) fields)]
    (cond
      (and value-field property-field entity-key)
      (inference :role/CustomPropertyTable
                 (tru "it has {0}, {1} and {2} columns" (:name entity-key) (:name property-field) (:name value-field))
                 :high)

      ;; a table of field definitions; a plain `name` next to a `type` is too common to count
      (and label-field type-field (not= "name" (field-name label-field)))
      (inference :role/ConfigurationTable
                 (tru "it has {0} and {1} columns, like a table of field definitions"
                      (:name label-field) (:name type-field))
                 :low))))

(defn- infer-from-columns [fields]
  (let [pks         (filter pk? fields)
        fks         (filter fk? fields)
        dates       (filter temporal? fields)
        non-keys    (remove pk? fields)
        updated-at? (some #(named? updated-pattern %) fields)]
    (or (infer-custom-property-role fields)
        (let [valid-from (some #(when (valid-from? %) %) fields)
              valid-to   (some #(when (valid-to? %) %) fields)]
          (when (and valid-from valid-to)
            (inference :role/HistoryDimension
                       (tru "it has {0} and {1} columns" (:name valid-from) (:name valid-to))
                       :high)))
        (let [milestones (filter milestone? fields)
              status     (some #(when (status? %) %) fields)]
          (when (and (>= (count milestones) 2) status)
            (inference :role/AccumulatingSnapshotFact
                       (tru "it has {0} milestone dates and {1}" (count milestones) (:name status))
                       :low)))
        (when (and (<= (count pks) 1)
                   (<= (count fields) 5)
                   (seq non-keys)
                   (every? #(named? label-pattern %) non-keys))
          (inference :role/LookupDimension (tru "it only has a key and label columns") :low))
        (when (and (= (count dates) 1)
                   (not updated-at?)
                   (seq fks))
          (inference :role/EventFact
                     (tru "it has one timestamp, no updated_at, and a link to {0}" (:name (first fks)))
                     :low))
        (when (and (= (count pks) 1)
                   (some #(named? label-pattern %) fields)
                   (some #(named? created-pattern %) fields)
                   updated-at?)
          (inference :role/EntityDimension (tru "it has a single key, a name, and created and updated dates") :low)))))

(defn- infer-from-name [table-name]
  (let [table-name (u/lower-case-en table-name)]
    (some (fn [[pattern role confidence]]
            (when (re-find pattern table-name)
              (inference role (tru "its name {0} matches the naming pattern of a {1} table" table-name (name role))
                         confidence)))
          name-rules)))

(mu/defn infer-table-role :- [:maybe RoleInference]
  "Propose a role for the Table named `table-name` from its `fields`. Signals are tried strongest first: the shape of
  the keys, then the columns, then the table name. Returns the role, a one-line reason for an admin, and whether
  the guess is confident enough to apply without review; nil when no signal matches."
  [table-name :- :string
   fields     :- [:sequential Field]]
  (or (infer-from-keys fields)
      (infer-from-columns fields)
      (infer-from-name table-name)))
