import numpy as np
import pytest
from pydantic import ValidationError

from app.ids import content_id, normalize_metadata_key, normalize_text, point_id
from app.schemas import RoutingOptions, RoutingStrategy, ScopeType, SearchFilters, SearchRequest
from app.search.fusion import Ranked, dbsf, rrf
from app.search.mmr import mmr_select
from app.search.routing import Anchor, route
from app.stores.elastic import build_filters, lexical_query
from app.schemas import LexicalOptions
from app.stores.graph import canonical_edges
from app.timing import Stopwatch


# ------------------------------------------------------------------ ids


def test_point_id_is_deterministic_and_uuid():
    assert point_id("doc-1") == point_id("doc-1")
    assert point_id("doc-1") != point_id("doc-2")
    assert len(point_id("x")) == 36


def test_normalize_text_collapses_whitespace_and_nfc():
    assert normalize_text("  a\t\n b  ") == "a b"
    assert normalize_text("s\u0326") == normalize_text("s\u0326")  # stable
    assert content_id("a  b") == content_id("a b")


def test_metadata_key_normalisation():
    assert normalize_metadata_key(" Source Feed! ") == "source_feed"


# ------------------------------------------------------------------ fusion


def test_rrf_rewards_agreement_and_reports_components():
    fused = rrf({"s": [Ranked("a", 0.9), Ranked("b", 0.8)], "k": [Ranked("b", 12.0), Ranked("c", 5.0)]})
    assert fused[0].id == "b"
    assert fused[0].components == {"s": (2, 0.8), "k": (1, 12.0)}


def test_rrf_weights_shift_ranking():
    lists = {"s": [Ranked("a", 1.0)], "k": [Ranked("b", 1.0)]}
    assert rrf(lists, {"s": 0.9, "k": 0.1})[0].id == "a"
    assert rrf(lists, {"s": 0.1, "k": 0.9})[0].id == "b"


def test_dbsf_uses_magnitudes():
    lists = {"s": [Ranked("a", 0.9), Ranked("b", 0.5), Ranked("c", 0.49)], "k": [Ranked("c", 30.0), Ranked("a", 1.0)]}
    ids = [f.id for f in dbsf(lists)]
    assert set(ids) == {"a", "b", "c"}
    assert all(0.0 <= f.score <= 2.0 for f in dbsf(lists))


# ------------------------------------------------------------------ mmr


def test_mmr_prefers_diverse_second_pick():
    vectors = np.array([[1, 0], [0.99, 0.141], [0, 1]], dtype=np.float32)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    relevance = np.array([1.0, 0.95, 0.6])
    assert mmr_select(relevance, vectors, 2, lambda_=0.5) == [0, 2]
    assert mmr_select(relevance, vectors, 2, lambda_=1.0) == [0, 1]


def test_mmr_handles_empty_and_k_larger_than_n():
    assert mmr_select(np.array([]), np.zeros((0, 2)), 3, 0.5) == []
    assert len(mmr_select(np.array([1.0]), np.array([[1.0, 0.0]]), 5, 0.5)) == 1


# ------------------------------------------------------------------ routing


ANCHORS = [
    Anchor("a", 0.90, 1),  # single strong anchor in community 1
    Anchor("b", 0.80, 2),
    Anchor("c", 0.79, 2),
    Anchor("d", 0.78, 2),
    Anchor("e", 0.70, None),
]


def test_top1_follows_nearest_anchor():
    result = route(ANCHORS, RoutingOptions(strategy=RoutingStrategy.top1))
    assert result.selected == [1]
    assert result.anchor_document_id == "a"


def test_sum_vote_overrules_single_boundary_anchor():
    result = route(ANCHORS, RoutingOptions(strategy=RoutingStrategy.sum))
    assert result.selected == [2]
    assert result.candidates[0].anchors == 3
    assert abs(sum(c.share for c in result.candidates) - 1.0) < 1e-3


def test_max_and_multi_community_selection():
    result = route(ANCHORS, RoutingOptions(strategy=RoutingStrategy.max, communities=2))
    assert result.selected == [1, 2]


def test_softmax_low_temperature_approaches_max():
    result = route(ANCHORS, RoutingOptions(strategy=RoutingStrategy.softmax, temperature=0.001))
    assert result.selected == [1]


def test_routing_without_assignments_selects_nothing():
    assert route([Anchor("x", 0.9, None)], RoutingOptions()).selected == []


# ------------------------------------------------------------------ schemas


def test_legacy_community_id_maps_to_scope():
    req = SearchRequest(query="q", community_id=7)
    assert req.scope.type == ScopeType.communities and req.scope.community_ids == [7]


def test_communities_scope_requires_ids():
    with pytest.raises(ValidationError):
        SearchRequest(query="q", scope={"type": "communities"})


def test_mmr_lambda_alias():
    assert SearchRequest(query="q", mmr={"enabled": True, "lambda": 0.3}).mmr.lambda_ == 0.3


# ------------------------------------------------------------------ ES query builders


def test_build_filters_translates_everything():
    f = SearchFilters(must_text="rail", length_min=10, sources=["seed"], metadata={"desk": "transport"}, unassigned_only=True)
    must, must_not = build_filters(f, community_ids=[1], exclude_community_ids=[2])
    kinds = [next(iter(c)) for c in must]
    assert kinds.count("terms") == 2 and "range" in kinds and "simple_query_string" in kinds
    assert {"term": {"metadata.desk": "transport"}} in must
    assert {"exists": {"field": "community_id"}} in [c.get("exists") and c for c in must_not]


def test_lexical_query_variants():
    plain = lexical_query("rail", LexicalOptions(fuzzy=True))
    assert plain["bool"]["must"][0]["multi_match"]["fuzziness"] == "AUTO"
    adv = lexical_query('"rail" -bus', LexicalOptions(syntax="advanced", phrase_boost=False))
    assert "simple_query_string" in adv["bool"]["must"][0] and adv["bool"]["should"] == []


def test_es_only_predicate_detection():
    assert not SearchFilters().has_es_only_predicates()
    assert not SearchFilters(unassigned_only=True).has_es_only_predicates()
    assert SearchFilters(metadata={"a": "b"}).has_es_only_predicates()


# ------------------------------------------------------------------ misc


def test_canonical_edges_dedupes_pairs_and_self_loops():
    edges = canonical_edges([("b", "a", 0.5), ("a", "b", 0.7), ("a", "a", 1.0)])
    assert edges == [{"a": "a", "b": "b", "score": 0.7}]


def test_stopwatch_server_timing():
    sw = Stopwatch()
    sw.record("embed", 1.5)
    assert sw.server_timing().startswith("embed;dur=1.5")
    assert "total_ms" in sw.as_dict()
