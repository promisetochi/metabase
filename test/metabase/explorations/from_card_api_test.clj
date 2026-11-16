(ns metabase.explorations.from-card-api-test
  "`GET /api/exploration/from-card/:card-id`, `POST /api/exploration/from-card`, and starting a Research with an
  `explore_filters` scope from the plan."
  (:require
   [clojure.test :refer :all]
   [metabase.collections.models.collection :as collection]
   [metabase.explorations.api]
   [metabase.explorations.query-plan.mbql :as qp.mbql]
   [metabase.lib.core :as lib]
   [metabase.test :as mt]
   [metabase.test.fixtures :as fixtures]
   [toucan2.core :as t2]))

(use-fixtures :once (fixtures/initialize :db :web-server :test-users))

(defmacro ^:private chart
  "Attributes for a saved question on the Orders table from a literal MBQL clause map."
  [chart-name clauses]
  `{:name          ~chart-name
    :type          :question
    :display       :bar
    :database_id   (mt/id)
    :table_id      (mt/id :orders)
    :dataset_query (mt/mbql-query ~'orders ~clauses)})

(defmacro ^:private metric-attrs [metric-name clauses]
  `(assoc (chart ~metric-name ~clauses) :type :metric :display :scalar))

(defn- metrics-named
  "The metrics whose name starts with `prefix`."
  [prefix]
  (filter #(.startsWith ^String (:name %) prefix) (t2/select :model/Card :type "metric" :archived false)))

(defn- prepared-metric-id
  "The metric the response of `POST /from-card` offers for the plan."
  [resp]
  (-> resp :metrics first :id))

(deftest preview-test
  (mt/with-temp [:model/Card sql    {:name "SQL" :type :question :database_id (mt/id)
                                     :dataset_query (mt/native-query {:query "select 1"})}
                 :model/Card model  (assoc (chart "A model" {}) :type :model)
                 :model/Card two    (chart "Two numbers" {:aggregation [[:sum $total] [:count]]})
                 :model/Card ok     (chart "Revenue by product" {:aggregation [[:sum $total]] :breakout [$product_id]})]
    (testing "a SQL question, a model and a chart with several aggregations cannot be researched"
      (is (= {:eligible false :reason "native"}
             (mt/user-http-request :rasta :get 200 (str "exploration/from-card/" (:id sql)))))
      (is (= {:eligible false :reason "model"}
             (mt/user-http-request :rasta :get 200 (str "exploration/from-card/" (:id model)))))
      (is (= {:eligible false :reason "aggregation-count"}
             (mt/user-http-request :rasta :get 200 (str "exploration/from-card/" (:id two))))))
    (testing "an aggregated chart can, and with no metric yet there is nothing to reuse"
      (is (= {:eligible true :exact nil :similar []}
             (mt/user-http-request :rasta :get 200 (str "exploration/from-card/" (:id ok))))))
    (testing "the preview creates nothing"
      (is (empty? (metrics-named "Revenue by product"))))))

(deftest preview-offers-existing-metrics-test
  (mt/with-temp [:model/Card ok      (chart "Revenue by product" {:aggregation [[:sum $total]] :breakout [$product_id]})
                 :model/Card exact   (metric-attrs "Revenue" {:aggregation [[:sum $total]]})
                 :model/Card similar (metric-attrs "Big orders" {:aggregation [[:sum $total]] :filter [:> $total 50]})]
    (let [resp (mt/user-http-request :rasta :get 200 (str "exploration/from-card/" (:id ok)))]
      (is (= (:id exact) (-> resp :exact :id)))
      (is (= [(:id similar)] (map :id (:similar resp)))))))

(deftest preview-of-a-metric-test
  (mt/with-temp [:model/Card metric (metric-attrs "Revenue" {:aggregation [[:sum $total]]})]
    (is (= (:id metric)
           (-> (mt/user-http-request :rasta :get 200 (str "exploration/from-card/" (:id metric))) :metric :id)))))

(deftest prepare-from-a-chart-test
  (mt/with-temp [:model/Card ok (chart "Revenue by product" {:aggregation [[:sum $total]] :breakout [$product_id]})]
    (let [personal-id (:id (collection/user->personal-collection (mt/user->id :rasta)))
          researches  #(t2/count :model/Exploration)
          before      (researches)
          first-resp  (mt/user-http-request :rasta :post 200 "exploration/from-card" {:card_id (:id ok)})
          metrics     (metrics-named "Revenue by product")]
      (testing "a metric is derived from the chart and saved in the person's personal collection"
        (is (= 1 (count metrics)))
        (is (= personal-id (:collection_id (first metrics))))
        (is (= (:id (first metrics)) (prepared-metric-id first-resp))))
      (testing "the response is shaped like GET /dimensions, with dimensions to slice the metric by"
        (is (seq (-> first-resp :metrics first :dimension_ids)))
        (is (seq (:dimension_groups first-resp))))
      (testing "no Research is started: that is left to the plan"
        (is (= before (researches))))
      (testing "preparing again from the same chart reuses the metric instead of creating another"
        (let [second-resp (mt/user-http-request :rasta :post 200 "exploration/from-card" {:card_id (:id ok)})]
          (is (= 1 (count (metrics-named "Revenue by product"))))
          (is (= (:id (first metrics)) (prepared-metric-id second-resp))))))))

(defn- default-time-dimension
  "What Research reads as the date dimension of the metric with `metric-id`: `[column unit display-name]`, or nil."
  [metric-id]
  (let [card (t2/select-one :model/Card :id metric-id)]
    (qp.mbql/default-time-dimension-col (lib/query (mt/metadata-provider) (:dataset_query card)) card)))

(deftest prepare-from-a-chart-by-date-keeps-the-date-as-the-default-dimension-test
  ;; Each chart has its own aggregation: two charts that say the same thing share one metric, and the second would reuse
  ;; the first's instead of making its own.
  (mt/with-temp [:model/Card by-month   (chart "Revenue by month" {:aggregation [[:sum $total]]
                                                                   :breakout    [!month.created_at]})
                 :model/Card by-week    (chart "Average order by week" {:aggregation [[:avg $total]]
                                                                        :breakout    [$product_id !week.created_at]})
                 :model/Card by-product (chart "Orders by product" {:aggregation [[:count]]
                                                                    :breakout    [$product_id]})]
    (letfn [(prepare [card]
              (prepared-metric-id (mt/user-http-request :rasta :post 200 "exploration/from-card" {:card_id (:id card)})))]
      (testing "the date a chart was broken out by is the metric's default dimension, at the chart's unit"
        (let [[column unit] (default-time-dimension (prepare by-month))]
          (is (= (mt/id :orders :created_at) (:id column)))
          (is (= :month unit))))
      (testing "the date wins over another breakout, whatever its place, and keeps its own unit"
        (let [[column unit] (default-time-dimension (prepare by-week))]
          (is (= (mt/id :orders :created_at) (:id column)))
          (is (= :week unit))))
      (testing "a chart with no date breakout gives a metric with no default dimension"
        (is (nil? (default-time-dimension (prepare by-product))))))))

(deftest prepare-with-a-chosen-metric-test
  (mt/with-temp [:model/Card ok      (chart "Revenue by product" {:aggregation [[:sum $total]] :breakout [$product_id]})
                 :model/Card similar (metric-attrs "Big orders" {:aggregation [[:sum $total]] :filter [:> $total 50]})]
    (let [resp (mt/user-http-request :rasta :post 200 "exploration/from-card"
                                     {:card_id (:id ok) :metric_id (:id similar)})]
      (testing "the metric the person chose is used, and no new metric is made"
        (is (= (:id similar) (prepared-metric-id resp)))
        (is (empty? (metrics-named "Revenue by product")))))
    (testing "only a metric can be chosen"
      (mt/user-http-request :rasta :post 400 "exploration/from-card"
                            {:card_id (:id ok) :metric_id (:id ok)}))))

(deftest prepare-from-a-metric-test
  (mt/with-temp [:model/Card metric (metric-attrs "Revenue" {:aggregation [[:sum $total]]})]
    (let [resp (mt/user-http-request :rasta :post 200 "exploration/from-card" {:card_id (:id metric)})]
      (is (= (:id metric) (prepared-metric-id resp)))
      (is (empty? (metrics-named "Revenue (metric)"))))))

(deftest prepare-rejects-charts-that-cannot-be-researched-test
  (mt/with-temp [:model/Card model (assoc (chart "A model" {}) :type :model)]
    (mt/user-http-request :rasta :post 400 "exploration/from-card" {:card_id (:id model)})))

(deftest prepare-requires-access-to-the-chart-test
  (mt/with-non-admin-groups-no-root-collection-perms
    (mt/with-temp [:model/Card ok (chart "Revenue by product" {:aggregation [[:sum $total]] :breakout [$product_id]})]
      (testing "someone who cannot read the chart cannot prepare a Research from it, or preview one"
        (mt/user-http-request :rasta :post 403 "exploration/from-card" {:card_id (:id ok)})
        (mt/user-http-request :rasta :get 403 (str "exploration/from-card/" (:id ok)))
        (is (empty? (metrics-named "Revenue by product")))))))

(deftest breakdown-of-a-metric-test
  (mt/with-temp [:model/Card metric   (metric-attrs "Revenue" {:aggregation [[:sum $total]]})
                 :model/Card plain    (chart "Revenue by product" {:aggregation [[:metric (:id metric)]]
                                                                   :breakout    [$product_id]})
                 :model/Card filtered (chart "Big revenue by product" {:aggregation [[:metric (:id metric)]]
                                                                       :breakout    [$product_id]
                                                                       :filter      [:> $total 50]})]
    (testing "a plain breakdown of a metric researches that metric itself and creates no new one"
      (is (= (:id metric)
             (-> (mt/user-http-request :rasta :get 200 (str "exploration/from-card/" (:id plain))) :metric :id)))
      (let [resp (mt/user-http-request :rasta :post 200 "exploration/from-card" {:card_id (:id plain)})]
        (is (= (:id metric) (prepared-metric-id resp)))
        (is (empty? (metrics-named "Revenue by product")))))
    (testing "a breakdown that adds its own filter is a different number, so a metric is derived for it"
      (is (nil? (:metric (mt/user-http-request :rasta :get 200 (str "exploration/from-card/" (:id filtered))))))
      (let [resp (mt/user-http-request :rasta :post 200 "exploration/from-card" {:card_id (:id filtered)})]
        (is (not= (:id metric) (prepared-metric-id resp)))
        (is (= 1 (count (metrics-named "Big revenue by product"))))))))

(deftest plan-scoped-to-a-clicked-point-test
  (mt/with-temp [:model/Card ok (chart "Revenue by product" {:aggregation [[:sum $total]] :breakout [$product_id]})]
    (let [prepared (mt/user-http-request :rasta :post 200 "exploration/from-card" {:card_id (:id ok)})
          metric   (first (:metrics prepared))
          dim      (-> prepared :dimension_groups first :dimensions first)
          block    (fn [filters]
                     {:metrics    [(cond-> {:card_id (:id metric) :dimension_mappings (:dimension_mappings metric)}
                                     filters (assoc :explore_filters filters))]
                      :dimensions [{:dimension_id (:id dim) :display_name (:display_name dim)}]})
          start    (fn [filters]
                     (mt/user-http-request :rasta :post 200 "exploration"
                                           {:name "Research" :blocks [(block filters)]}))
          stored   (fn [resp]
                     (-> (t2/select-one :model/ExplorationBlock
                                        :exploration_thread_id (-> resp :threads first :id))
                         :metrics first))
          filter*  {:operator      "="
                    :field_ref     ["field" (mt/id :orders :product_id) nil]
                    :value         3
                    :display_value "3"}]
      (testing "a filter sent with the plan is kept, and labelled, on the stored metric selection"
        (let [saved (first (:explore_filters (stored (start [filter*]))))]
          (is (= "3" (:display_value saved)))
          (is (string? (:dimension_name saved)))))
      (testing "a plan without filters stores none"
        (is (not (contains? (stored (start nil)) :explore_filters)))))))
