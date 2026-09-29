"""Condition-tree compiler: RAQB JSON → Elasticsearch clause and inspector text."""

import pytest

from app.errors import ValidationFailed
from app.schemas import SearchFilters
from app.search.conditions import (
    FIELD_SPECS,
    MAX_DEPTH,
    MAX_RULES,
    canonical_operator,
    compile_tree,
    count_rules,
    describe_tree,
    metadata_spec,
)
from app.stores.elastic import build_filters


def rule(field, operator, *value):
    return {"type": "rule", "properties": {"field": field, "operator": operator, "value": list(value)}}


def group(*children, conjunction="AND", negate=False):
    return {
        "type": "group",
        "properties": {"conjunction": conjunction, "not": negate},
        "children1": {f"n{i}": child for i, child in enumerate(children)},
    }


# ------------------------------------------------------------------ per field kind


def test_fulltext_operators():
    assert compile_tree(group(rule("text", "like", "rail way"))) == {
        "multi_match": {"query": "rail way", "fields": ["text", "text.folded"], "operator": "and"}
    }
    assert compile_tree(group(rule("text", "any_words", "rail bus")))["multi_match"]["operator"] == "or"
    assert compile_tree(group(rule("text", "not_like", "bus"))) == {
        "bool": {"must_not": [{"multi_match": {"query": "bus", "fields": ["text", "text.folded"], "operator": "and"}}]}
    }
    phrase = compile_tree(group(rule("text", "phrase", "căi ferate")))
    assert phrase["bool"]["should"] == [{"match_phrase": {"text": "căi ferate"}}, {"match_phrase": {"text.folded": "căi ferate"}}]
    query = compile_tree(group(rule("text", "query_syntax", '"rail" -bus')))["simple_query_string"]
    assert query["flags"] == "ALL" and query["lenient"] and query["default_operator"] == "AND"


def test_keyword_operators_escape_wildcards():
    assert compile_tree(group(rule("external_id", "equal", "news-1"))) == {"term": {"external_id": "news-1"}}
    assert compile_tree(group(rule("external_id", "like", "a*b?"))) == {
        "wildcard": {"external_id": {"value": "*a\\*b\\?*", "case_insensitive": True}}
    }
    assert compile_tree(group(rule("external_id", "starts_with", "News"))) == {
        "prefix": {"external_id": {"value": "News", "case_insensitive": True}}
    }
    assert compile_tree(group(rule("external_id", "ends_with", "01")))["wildcard"]["external_id"]["value"] == "*01"
    assert "must_not" in compile_tree(group(rule("external_id", "not_like", "x")))["bool"]


def test_source_and_community_selects():
    assert compile_tree(group(rule("source", "select_any_in", ["seed", "csv:a.csv"]))) == {
        "terms": {"source": ["seed", "csv:a.csv"]}
    }
    # multiselect values arrive nested one level deeper, as strings from the widget
    assert compile_tree(group({"type": "rule", "properties": {
        "field": "community_id", "operator": "select_any_in", "value": [["3", 5]]}})) == {"terms": {"community_id": [3, 5]}}
    assert compile_tree(group(rule("community_id", "is_null"))) == {
        "bool": {"must_not": [{"exists": {"field": "community_id"}}]}
    }
    assert compile_tree(group(rule("community_id", "is_not_null"))) == {"exists": {"field": "community_id"}}
    assert compile_tree(group(rule("community_id", "select_not_equals", 4))) == {
        "bool": {"must_not": [{"term": {"community_id": 4}}]}
    }


def test_numbers_and_dates():
    assert compile_tree(group(rule("length", "greater", 200))) == {"range": {"length": {"gt": 200}}}
    assert compile_tree(group(rule("length", "between", 10, 99))) == {"range": {"length": {"gte": 10, "lte": 99}}}
    assert compile_tree(group(rule("length", "not_between", 10, 99)))["bool"]["must_not"][0]["range"]["length"] == {
        "gte": 10, "lte": 99
    }
    assert compile_tree(group(rule("updated_at", "greater_or_equal", "2026-01-31 08:00:00"))) == {
        "range": {"updated_at": {"gte": "2026-01-31T08:00:00"}}
    }
    assert compile_tree(group(rule("created_at", "less", "2026-01-31")))["range"]["created_at"] == {"lt": "2026-01-31"}
    with pytest.raises(ValidationFailed, match="date"):
        compile_tree(group(rule("created_at", "less", "yesterday")))
    with pytest.raises(ValidationFailed, match="number"):
        compile_tree(group(rule("length", "greater", "long")))


def test_metadata_is_exact_and_rejects_contains():
    assert compile_tree(group(rule("metadata.Desk", "select_equals", "transport"))) == {
        "term": {"metadata.desk": "transport"}
    }
    assert compile_tree(group(rule("metadata.desk", "starts_with", "tra")))["prefix"]["metadata.desk"]["value"] == "tra"
    assert compile_tree(group(rule("metadata.desk", "is_null"))) == {
        "bool": {"must_not": [{"exists": {"field": "metadata.desk"}}]}
    }
    with pytest.raises(ValidationFailed, match="does not support"):
        compile_tree(group(rule("metadata.desk", "like", "port")))


# ------------------------------------------------------------------ structure


def test_or_not_nesting():
    tree = group(
        rule("length", "greater", 100),
        group(rule("source", "select_equals", "seed"), rule("community_id", "is_null"), conjunction="OR", negate=True),
    )
    clause = compile_tree(tree)
    assert list(clause["bool"]) == ["filter"]
    negated = clause["bool"]["filter"][1]
    assert negated["bool"]["must_not"][0]["bool"]["minimum_should_match"] == 1
    assert len(negated["bool"]["must_not"][0]["bool"]["should"]) == 2


def test_incomplete_rules_are_skipped_not_errors():
    tree = group(
        {"type": "rule", "properties": {"field": None, "operator": None, "value": []}},
        rule("text", "like"),
        rule("length", "between", 10, None),
        group(),
    )
    assert compile_tree(tree) is None
    assert describe_tree(tree) == ""
    assert count_rules(tree) == 3
    assert compile_tree(None) is None and compile_tree({}) is None


def test_list_children_and_top_level_group_settings():
    tree = {"type": "group", "conjunction": "OR", "children": [rule("length", "less", 5), rule("length", "greater", 50)]}
    assert "should" in compile_tree(tree)["bool"]


def test_limits_and_unknown_fields():
    deep = rule("length", "greater", 1)
    for _ in range(MAX_DEPTH + 1):
        deep = group(deep)
    with pytest.raises(ValidationFailed, match="nest"):
        compile_tree(deep)
    with pytest.raises(ValidationFailed, match="at most"):
        compile_tree(group(*[rule("length", "greater", i) for i in range(MAX_RULES + 1)]))
    with pytest.raises(ValidationFailed, match="not a filterable field"):
        compile_tree(group(rule("password", "equal", "x")))
    with pytest.raises(ValidationFailed, match="does not support"):
        compile_tree(group(rule("length", "like", "x")))
    with pytest.raises(ValidationFailed, match="Unknown operator"):
        compile_tree(group(rule("length", "regex", "x")))
    with pytest.raises(ValidationFailed, match="conjunction"):
        compile_tree({"type": "group", "properties": {"conjunction": "XOR"}, "children1": [rule("length", "less", 1)]})


def test_describe_reads_like_the_query():
    tree = group(
        rule("text", "like", "rail"),
        rule("length", "greater", 200),
        group(rule("community_id", "select_any_in", [3, 5]), rule("community_id", "is_null"),
              rule("metadata.desk", "select_equals", "transport"), conjunction="OR", negate=True),
        group(rule("length", "less", 900)),  # a bracket around one rule adds nothing
    )
    assert describe_tree(tree) == (
        'Text contains "rail"\n'
        "AND\n"
        "Length > 200\n"
        "AND\n"
        "NOT (\n"
        "    Community in C3, C5\n"
        "    OR\n"
        "    Community is none\n"
        "    OR\n"
        "    desk = transport\n"
        ")\n"
        "AND\n"
        "Length < 900"
    )


def test_catalogue_operators_all_compile():
    """Every operator the catalogue publishes is one the compiler accepts for that field."""
    samples = {"fulltext": "rail", "keyword": "x", "enum": "seed", "community": 1, "number": 5, "datetime": "2026-01-01",
               "metadata": "x"}
    for spec in [*FIELD_SPECS, metadata_spec("desk")]:
        for operator in spec.operators:
            canonical = canonical_operator(operator)
            values = [] if canonical in ("empty", "not_empty") else (
                [samples[spec.kind], samples[spec.kind]] if canonical in ("between", "not_between") else [samples[spec.kind]]
            )
            assert compile_tree(group(rule(spec.name, operator, *values))) is not None, (spec.name, operator)


def test_tree_flows_into_search_filters():
    tree = group(rule("length", "greater", 10))
    filters = SearchFilters(condition_tree=tree)
    assert filters.has_es_only_predicates()
    must, _ = build_filters(filters)
    assert {"range": {"length": {"gt": 10}}} in must
    assert not SearchFilters(condition_tree=group(rule("text", "like"))).has_es_only_predicates()
