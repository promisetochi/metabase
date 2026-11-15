(ns metabase.explorations.from-card
  "Starting a Research from a chart.

  Research works on metrics, and a metric is a saved aggregation. A chart on a dashboard is usually one aggregation with
  a breakdown, so the metric behind it is the chart's query with the breakdown, the sort and the limit taken off
  ([[derive-metric-query]]).

  Before a metric is created, [[find-matches]] looks for one that already says the same thing, or nearly the same
  thing, so the person is not left with a pile of near-duplicates:

  - an *exact* match has the same data source, joins, expressions, filters and aggregation, and is reused;
  - a *similar* match has the same data source and aggregation, with different filters, joins or expressions, and is
    only suggested."
  (:require
   [clojure.walk :as walk]
   [metabase.api.common :as api]
   [metabase.collections.models.collection :as collection]
   [metabase.explorations.db :as explorations.db]
   [metabase.explorations.impl :as impl]
   [metabase.lib-be.core :as lib-be]
   [metabase.lib.core :as lib]
   [metabase.models.interface :as mi]
   [metabase.queries.core :as queries]
   [metabase.query-permissions.core :as query-perms]
   [metabase.util.i18n :refer [tru]]))

(set! *warn-on-reflection* true)

;;; ------------------------------------------------ Deriving the metric ------------------------------------------------

(defn derive-metric-query
  "Turn the query behind a chart into the query of its metric: keep the data source, joins, expressions, filters and the
  single aggregation, and drop the breakouts, sort and limit so Research can slice the metric itself.

  Returns `{:query <query>}`, or `{:ineligible <reason>}` when the chart cannot be a metric:

  - `:native`: a SQL question has no aggregation to lift out;
  - `:multi-stage`: a metric is a single stage;
  - `:aggregation-count`: a metric has exactly one aggregation, and this chart has none or several."
  [query]
  (cond
    (lib/any-native-stage? query)
    {:ineligible :native}

    (not= 1 (lib/stage-count query))
    {:ineligible :multi-stage}

    (not= 1 (count (lib/aggregations query)))
    {:ineligible :aggregation-count}

    :else
    (let [no-sort (reduce lib/remove-clause query (lib/order-bys query))
          derived (-> no-sort lib/remove-all-breakouts (lib/limit nil))]
      ;; A chart that passes the checks above can still break a rule only the library knows, for example a metric may have at most one date breakout.
      (if (lib/can-save? derived :metric)
        {:query derived}
        {:ineligible :not-a-metric}))))

;;; ------------------------------------------------ Comparing queries ------------------------------------------------

(def ^:private meaningful-options
  "The options on a clause that change what it means. Everything else on a clause (a fresh uuid, inferred types, display
  names) differs between two queries that mean the same thing."
  #{:temporal-unit :binning :join-alias :source-field :source-field-join-alias})

(defn- canonical
  "`x` with the noise taken off every clause and map, so two queries that mean the same thing compare equal."
  [x]
  (walk/postwalk
   (fn [form]
     (cond
       (map? form)
       (dissoc form :lib/uuid)

       (and (vector? form) (keyword? (first form)) (map? (second form)))
       (assoc form 1 (select-keys (second form) meaningful-options))

       :else form))
   x))

(defn fingerprint
  "What a single-stage query means, for comparing it with another: `{:database :source :aggregation :shape}`. Two queries
  with the same `:database`, `:source` and `:aggregation` are about the same number; `:shape` holds the rest (joins,
  expressions, filters) that decides whether they are the same number."
  [query]
  (let [stage (first (:stages query))]
    {:database    (:database query)
     :source      (select-keys stage [:source-table :source-card])
     :aggregation (canonical (:aggregation stage))
     :shape       {:joins       (canonical (vec (:joins stage)))
                   :expressions (canonical (vec (:expressions stage)))
                   :filters     (canonical (set (:filters stage)))}}))

(defn- comparison [derived candidate]
  (cond
    (= derived candidate)                          :exact
    (= (dissoc derived :shape) (dissoc candidate :shape)) :similar))

;;; ------------------------------------------------ Finding existing metrics ------------------------------------------------

(defn- candidate-metrics
  "Metrics the current user can read that are built on the same table as `fingerprint`'s source, which is the cheap way to
  narrow the field before comparing queries. A question built on another saved question has no such shortcut, so it
  matches nothing and the caller creates a metric."
  [{:keys [database source]}]
  (when-let [table-id (:source-table source)]
    (->> (explorations.db/unarchived-metric-cards-on-table database table-id)
         (filter mi/can-read?))))

(defn find-matches
  "Existing metrics that match `derived-query` (see [[derive-metric-query]]): `{:exact <metric or nil> :similar [<metric>]}`.
  Each metric is `{:id :name :description :collection_id :in_library}`. Metrics in the Library come first, since those
  are the curated ones, then the rest by name."
  [derived-query]
  (let [fp          (fingerprint derived-query)
        library-ids (or (impl/library-metrics-collection-ids) #{})
        results     (for [card (candidate-metrics fp)
                          :let [kind (comparison fp (fingerprint (:dataset_query card)))]
                          :when kind]
                      [kind (-> card
                                (select-keys [:id :name :description :collection_id])
                                (assoc :in_library (contains? library-ids (:collection_id card))))])
        by-kind     (group-by first results)
        ordered     (fn [kind] (->> (get by-kind kind)
                                    (map second)
                                    (sort-by (juxt (complement :in_library) :name))
                                    vec))]
    {:exact   (first (ordered :exact))
     :similar (ordered :similar)}))

;;; ------------------------------------------------ From a card to a metric ------------------------------------------------

(defn- card-query [card]
  (lib/query (lib-be/application-database-metadata-provider (:database_id card)) (:dataset_query card)))

(defn- slim [metric]
  (select-keys metric [:id :name :description :collection_id :in_library]))

(defn- metric-the-chart-is-built-on
  "The metric card a chart is just a breakdown of, or nil. That is a single-stage chart whose only aggregation is a saved
  metric and which adds no filters, joins or expressions of its own, so the chart and the metric are the same number and
  no new metric is needed. A chart that does add its own filters is not the same number, so it is derived instead."
  [query]
  (when (= 1 (lib/stage-count query))
    (let [stage        (first (:stages query))
          [aggregation] (:aggregation stage)
          [tag _opts metric-id] aggregation]
      (when (and (= 1 (count (:aggregation stage)))
                 (= :metric tag)
                 (empty? (:filters stage))
                 (empty? (:joins stage))
                 (empty? (:expressions stage)))
        (let [metric (explorations.db/card metric-id)]
          (when (and metric (= :metric (keyword (:type metric))) (mi/can-read? metric))
            metric))))))

(defn resolve-card
  "What a chart's `card` offers a Research, before anything is created:

  - `{:ineligible <reason>}`: it cannot be researched (see [[derive-metric-query]]; also `:model`);
  - `{:metric <card>}`: the card is a metric, or a breakdown of one, so that metric is used as it is;
  - `{:query <derived query>}`: the metric to derive from it."
  [card]
  (case (keyword (:type card))
    :metric {:metric card}
    :model  {:ineligible :model}
    (let [query (card-query card)]
      (if-let [metric (metric-the-chart-is-built-on query)]
        {:metric metric}
        (derive-metric-query query)))))

(defn preview
  "What to show before starting a Research from `card`: `{:eligible false :reason <reason>}`, or `{:eligible true}` with
  either `:metric` (the card is itself a metric) or `:exact` and `:similar` (see [[find-matches]])."
  [card]
  (let [{:keys [ineligible metric query]} (resolve-card card)]
    (cond
      ineligible {:eligible false :reason ineligible}
      metric     {:eligible true :metric (slim metric)}
      :else      (assoc (find-matches query) :eligible true))))

(defn create-metric!
  "Save `derived-query` as a metric in the current user's personal collection, named after the chart it came from. Checks
  what the REST endpoint for saving a card checks: the user can run the query, and can write to the collection."
  [derived-query source-card]
  (let [collection-id (:id (collection/user->personal-collection api/*current-user-id*))]
    (query-perms/check-run-permissions-for-query derived-query)
    (api/create-check :model/Card {:collection_id collection-id})
    (queries/create-card!
     {:name                   (tru "{0} (metric)" (:name source-card))
      :type                   :metric
      :dataset_query          derived-query
      :display                :scalar
      :description            (tru "Made from the question \"{0}\" so that it could be researched. Its breakdowns, sorting and limit were removed."
                                   (:name source-card))
      :collection_id          collection-id
      :visualization_settings {}}
     {:id api/*current-user-id*})))

(defn ensure-metric!
  "The metric to research for `card`: the card itself when it is a metric, the metric the caller chose (`metric-id`) when
  given, an exact match when one exists, and otherwise a new metric derived from the card.

  Throws a 400 with the reason when the chart cannot become a metric."
  [card metric-id]
  (let [{:keys [ineligible metric query]} (resolve-card card)]
    (cond
      ineligible (throw (ex-info (tru "This chart cannot be researched: {0}." (name ineligible))
                                 {:status-code 400 :reason ineligible}))
      metric     metric
      metric-id  (let [chosen (api/read-check :model/Card metric-id)]
                   (api/check-400 (= :metric (keyword (:type chosen))))
                   chosen)
      :else      (if-let [{:keys [id]} (:exact (find-matches query))]
                   (explorations.db/card id)
                   (create-metric! query card)))))
