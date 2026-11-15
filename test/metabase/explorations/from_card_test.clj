(ns metabase.explorations.from-card-test
  (:require
   [clojure.test :refer :all]
   [metabase.explorations.from-card :as from-card]
   [metabase.lib.core :as lib]
   [metabase.test :as mt]))

(set! *warn-on-reflection* true)

;; `mt/mbql-query` reads its clauses at macroexpansion time, so these helpers are macros that take a literal map.

(defmacro ^:private orders-query
  "A lib query on the Orders table from a literal MBQL clause map."
  [clauses]
  `(lib/query (mt/metadata-provider) (mt/mbql-query ~'orders ~clauses)))

(defmacro ^:private fingerprint-of [clauses]
  `(from-card/fingerprint (orders-query ~clauses)))

(defmacro ^:private metric-card
  "Attributes for a saved metric on the Orders table."
  [card-name clauses]
  `{:name          ~card-name
    :type          :metric
    :database_id   (mt/id)
    :table_id      (mt/id :orders)
    :dataset_query (mt/mbql-query ~'orders ~clauses)})

(deftest ^:parallel derive-metric-query-test
  (testing "the breakdown, sort and limit come off and the aggregation stays"
    (let [query   (orders-query {:aggregation [[:sum $total]]
                                 :breakout    [!month.created_at $product_id]
                                 :order-by    [[:desc [:aggregation 0]]]
                                 :limit       5})
          derived (:query (from-card/derive-metric-query query))]
      (is (some? derived))
      (is (empty? (lib/breakouts derived)))
      (is (empty? (lib/order-bys derived)))
      (is (nil? (lib/current-limit derived)))
      (is (= 1 (count (lib/aggregations derived))))
      (is (lib/can-save? derived :metric))))
  (testing "the chart's own filters stay, because without them the number would not match the chart"
    (let [query   (orders-query {:aggregation [[:sum $total]]
                                 :breakout    [$product_id]
                                 :filter      [:> $total 50]})
          derived (:query (from-card/derive-metric-query query))]
      (is (= 1 (count (lib/filters derived)))))))

(deftest ^:parallel derive-metric-query-ineligible-test
  (testing "a SQL question has no aggregation to lift out"
    (is (= {:ineligible :native}
           (from-card/derive-metric-query (lib/native-query (mt/metadata-provider) "select 1")))))
  (testing "a metric has exactly one aggregation"
    (is (= {:ineligible :aggregation-count}
           (from-card/derive-metric-query (orders-query {:aggregation [[:sum $total] [:count]]}))))
    (is (= {:ineligible :aggregation-count}
           (from-card/derive-metric-query (orders-query {})))))
  (testing "a metric is a single stage"
    (is (= {:ineligible :multi-stage}
           (from-card/derive-metric-query
            (lib/append-stage (orders-query {:aggregation [[:count]] :breakout [$product_id]}))))))
  (testing "breakouts are removed, so a chart with two date breakouts still derives a valid metric"
    (is (some? (:query (from-card/derive-metric-query
                        (orders-query {:aggregation [[:count]]
                                       :breakout    [!month.created_at !year.created_at]})))))))

(deftest ^:parallel fingerprint-test
  (testing "the same query built twice has the same fingerprint, whatever the generated ids"
    (is (= (fingerprint-of {:aggregation [[:sum $total]]})
           (fingerprint-of {:aggregation [[:sum $total]]}))))
  (testing "a different filter changes the shape and nothing else"
    (let [plain    (fingerprint-of {:aggregation [[:sum $total]]})
          filtered (fingerprint-of {:aggregation [[:sum $total]] :filter [:> $total 50]})]
      (is (not= plain filtered))
      (is (= (dissoc plain :shape) (dissoc filtered :shape)))))
  (testing "a different aggregation changes the fingerprint's core"
    (is (not= (dissoc (fingerprint-of {:aggregation [[:sum $total]]}) :shape)
              (dissoc (fingerprint-of {:aggregation [[:avg $total]]}) :shape)))))

(deftest find-matches-test
  (let [derived (:query (from-card/derive-metric-query
                         (orders-query {:aggregation [[:sum $total]] :breakout [$product_id]})))]
    (mt/with-temp [:model/Card exact    (metric-card "Revenue" {:aggregation [[:sum $total]]})
                   :model/Card similar  (metric-card "Big orders" {:aggregation [[:sum $total]]
                                                                   :filter      [:> $total 50]})
                   :model/Card _average (metric-card "Average order" {:aggregation [[:avg $total]]})
                   :model/Card archived (assoc (metric-card "Old revenue" {:aggregation [[:sum $total]]})
                                               :archived true)]
      (let [{exact-match :exact, similar-matches :similar} (mt/with-test-user :rasta (from-card/find-matches derived))]
        (testing "an identical metric is an exact match"
          (is (= (:id exact) (:id exact-match))))
        (testing "the same aggregation with another filter is only similar"
          (is (= [(:id similar)] (map :id similar-matches))))
        (testing "archived metrics never match"
          (is (not-any? #{(:id archived)} (cons (:id exact-match) (map :id similar-matches)))))))))

(deftest find-matches-without-a-match-test
  (testing "nothing matches when no metric uses the same aggregation"
    (let [derived (:query (from-card/derive-metric-query
                           (orders-query {:aggregation [[:max $total]] :breakout [$product_id]})))]
      (mt/with-temp [:model/Card _ (metric-card "Revenue" {:aggregation [[:sum $total]]})]
        (is (= {:exact nil :similar []}
               (mt/with-test-user :rasta (from-card/find-matches derived))))))))

(deftest find-matches-ignores-metrics-the-user-cannot-read-test
  (testing "a metric in a collection the user cannot read is never offered"
    (let [derived (:query (from-card/derive-metric-query
                           (orders-query {:aggregation [[:sum $total]] :breakout [$product_id]})))]
      (mt/with-temp [:model/Collection coll {}
                     :model/Card       _    (assoc (metric-card "Hidden revenue" {:aggregation [[:sum $total]]})
                                                   :collection_id (:id coll))]
        (mt/with-non-admin-groups-no-collection-perms coll
          (is (= {:exact nil :similar []}
                 (mt/with-test-user :rasta (from-card/find-matches derived)))))))))
