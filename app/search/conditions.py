"""Query-builder condition trees → Elasticsearch, and → readable text.

The explore, graph and community screens build nested conditions in the browser with
react-awesome-query-builder (RAQB). This module is the one place such a tree turns into
anything else:

* ``compile_tree``  → one Elasticsearch query clause. Because every consumer (document
  browse, keyword search, the semantic pre-filter, graph seeding) already speaks ES
  ``bool`` clauses, a single tree narrows all of them identically;
* ``describe_tree`` → the parenthesised text the query inspector shows.

Both walk the same structure with the same field table (``FIELD_SPECS``), so the text a
user reads is provably the shape of the query that ran, and the catalogue published to
the builder (``GET /explore/fields``) can never offer an operator the compiler refuses.

Accepted shape (RAQB's native JSON tree)::

    {"type": "group", "properties": {"conjunction": "AND", "not": false},
     "children1": {"a1": {"type": "rule", "properties":
         {"field": "length", "operator": "greater", "value": [200]}}}}

``children1`` and ``children`` are both honoured, as dict (id → node) or list, and group
settings may sit under ``properties`` or at the top level (older exports).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.errors import ValidationFailed
from app.ids import normalize_metadata_key

#: A tree deeper or larger than this is a denial-of-service rather than a question.
MAX_DEPTH = 12
MAX_RULES = 200

TEXT_FIELDS = ["text", "text.folded"]

# RAQB operator names (what the builder sends) → canonical operator. Canonical names
# map to themselves, so hand-written trees and API clients can use either spelling.
OPERATOR_ALIASES: dict[str, str] = {
    "equal": "eq",
    "select_equals": "eq",
    "not_equal": "ne",
    "select_not_equals": "ne",
    "like": "contains",
    "not_like": "not",
    "any_words": "any",
    "query_syntax": "query",
    "starts_with": "starts",
    "ends_with": "ends",
    "less": "lt",
    "less_or_equal": "lte",
    "greater": "gt",
    "greater_or_equal": "gte",
    "select_any_in": "in",
    "select_not_any_in": "not_in",
    "multiselect_equals": "in",
    "is_null": "empty",
    "is_empty": "empty",
    "is_not_null": "not_empty",
    "is_not_empty": "not_empty",
}
CANONICAL = {
    "eq", "ne", "contains", "not", "any", "phrase", "query", "starts", "ends",
    "gt", "gte", "lt", "lte", "between", "not_between", "in", "not_in", "empty", "not_empty",
}
VALUELESS = {"empty", "not_empty"}
MULTI = {"in", "not_in"}
RANGE = {"between", "not_between"}

_OPERATOR_TEXT = {
    "eq": "=",
    "ne": "≠",
    "contains": "contains",
    "not": "does not contain",
    "any": "contains any of",
    "phrase": "contains phrase",
    "query": "matches",
    "starts": "starts with",
    "ends": "ends with",
    "gt": ">",
    "gte": "≥",
    "lt": "<",
    "lte": "≤",
    "between": "between",
    "not_between": "not between",
    "in": "in",
    "not_in": "not in",
    "empty": "is empty",
    "not_empty": "is not empty",
}

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$")


def canonical_operator(operator: str) -> str:
    name = OPERATOR_ALIASES.get(operator, operator)
    if name not in CANONICAL:
        raise ValidationFailed(f"Unknown operator {operator!r}", details={"operator": operator})
    return name


@dataclass(frozen=True)
class FieldSpec:
    """One filterable field: what the builder shows and how the compiler treats it.

    ``operators`` are the RAQB names published to the builder, in display order; the
    compiler accepts exactly their canonical equivalents (plus aliases of those).
    """

    name: str
    label: str
    kind: str  # fulltext | keyword | enum | community | number | datetime | metadata
    es_field: str
    operators: tuple[str, ...]
    sortable: bool
    group: str
    description: str = ""
    allowed: frozenset[str] = field(default=frozenset(), compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "allowed", frozenset(canonical_operator(op) for op in self.operators))


_KEYWORD_OPS = ("equal", "not_equal", "like", "not_like", "starts_with", "ends_with")
_NUMBER_OPS = ("equal", "not_equal", "less", "less_or_equal", "greater", "greater_or_equal", "between", "not_between")
_DATE_OPS = ("less", "less_or_equal", "greater", "greater_or_equal", "between", "not_between")
_METADATA_OPS = (
    "select_equals", "select_not_equals", "select_any_in", "select_not_any_in", "starts_with", "is_null", "is_not_null",
)

FIELD_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec(
        "text", "Text", "fulltext", "text", ("like", "not_like", "any_words", "phrase", "query_syntax"), False, "content",
        "Analysed full text (diacritics folded). 'contains' needs every word; 'matches' accepts "
        '"phrases", -exclusions, a | b and prefix*.',
    ),
    FieldSpec("external_id", "External ID", "keyword", "external_id", _KEYWORD_OPS, True, "content",
              "The id column of the import (case-insensitive for contains/starts/ends)."),
    FieldSpec(
        "source", "Source", "enum", "source",
        ("select_equals", "select_not_equals", "select_any_in", "select_not_any_in", "is_null", "is_not_null",
         "like", "not_like"),
        True, "content", "Import source label, e.g. csv:news.csv or seed.",
    ),
    FieldSpec(
        "community_id", "Community", "community", "community_id",
        ("select_equals", "select_not_equals", "select_any_in", "select_not_any_in", "equal", "not_equal",
         "is_null", "is_not_null"),
        True, "graph",
        "Leiden community of the latest clustering run. Empty = in no community: not clustered yet, or "
        "too loosely linked to join a community (a community has at least two documents).",
    ),
    FieldSpec("community_version", "Clustering run", "number", "community_version",
              (*_NUMBER_OPS, "is_null", "is_not_null"), False, "graph",
              "Version of the clustering run that last placed the document. Empty = not clustered yet."),
    FieldSpec("length", "Length", "number", "length", _NUMBER_OPS, True, "content",
              "Characters in the normalised text."),
    FieldSpec("created_at", "Created", "datetime", "created_at", _DATE_OPS, True, "time",
              "First time the document was stored."),
    FieldSpec("updated_at", "Updated", "datetime", "updated_at", _DATE_OPS, True, "time",
              "Last time the text or metadata changed."),
)
FIELDS_BY_NAME: dict[str, FieldSpec] = {spec.name: spec for spec in FIELD_SPECS}

METADATA_PREFIX = "metadata."


def metadata_spec(key: str, label: str | None = None) -> FieldSpec:
    """The spec for one flattened metadata leaf.

    Keyed flattened fields behave like ``keyword`` for term/terms/prefix/exists, but ES
    rejects ``wildcard`` on them (verified on 9.5), so 'contains' is not offered.
    """
    normalised = normalize_metadata_key(key)
    if not normalised:
        raise ValidationFailed(f"{METADATA_PREFIX}{key!s} is not a valid metadata field")
    return FieldSpec(
        f"{METADATA_PREFIX}{normalised}", label or normalised, "metadata", f"metadata.{normalised}",
        _METADATA_OPS, False, "metadata", "Extra CSV column, stored exactly as imported.",
    )


def field_spec(name: str) -> FieldSpec:
    if name.startswith(METADATA_PREFIX):
        return metadata_spec(name[len(METADATA_PREFIX):])
    spec = FIELDS_BY_NAME.get(name)
    if spec is None:
        raise ValidationFailed(
            f"{name!r} is not a filterable field",
            details={"field": name, "available": sorted(FIELDS_BY_NAME) + ["metadata.<key>"]},
        )
    return spec


# ---------------------------------------------------------------------------- tree walking


def children_of(node: dict[str, Any]) -> list[dict[str, Any]]:
    raw = node.get("children1", node.get("children"))
    if raw is None:
        return []
    if isinstance(raw, dict):
        # Insertion order is on-screen order: the inspector reads top-down like the UI.
        return [child for child in raw.values() if isinstance(child, dict)]
    if isinstance(raw, list):
        return [child for child in raw if isinstance(child, dict)]
    raise ValidationFailed("Query group children must be a list or an object")


def _kind(node: dict[str, Any]) -> str:
    return str(node.get("type") or "group").lower()


def group_settings(node: dict[str, Any]) -> tuple[str, bool]:
    props = node.get("properties") or {}
    conjunction = str(props.get("conjunction") or node.get("conjunction") or "AND").upper()
    if conjunction not in ("AND", "OR"):
        raise ValidationFailed("conjunction must be AND or OR")
    return conjunction, bool(props.get("not", node.get("not")))


def _flatten(value: Any) -> list[Any]:
    """RAQB wraps every value in a list; a multiselect nests one more list inside it."""
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        value = [value]
    flat: list[Any] = []
    for item in value:
        if isinstance(item, (list, tuple)):
            flat.extend(item)
        else:
            flat.append(item)
    return flat


def _rule_parts(node: dict[str, Any]) -> tuple[str, str, list[Any]]:
    """Field, operator and non-empty values of one rule; field is "" while unchosen.

    ``between`` keeps its positional pair (a missing end stays ``None``) so an
    unfinished range is recognisable as such rather than silently one-sided.
    """
    props = node.get("properties") or {}
    field_name = str(props.get("field") or props.get("fieldName") or "")
    operator = str(props.get("operator") or "")
    raw = _flatten(props.get("value"))
    if OPERATOR_ALIASES.get(operator, operator) in RANGE:
        values = [None if v in (None, "") else v for v in raw[:2]]
    else:
        values = [v for v in raw if v is not None and v != ""]
    return field_name, operator, values


class _Counter:
    __slots__ = ("rules",)

    def __init__(self) -> None:
        self.rules = 0

    def tick(self) -> None:
        self.rules += 1
        if self.rules > MAX_RULES:
            raise ValidationFailed(f"A condition may contain at most {MAX_RULES} rules")


def count_rules(tree: dict[str, Any] | None) -> int:
    """How many rules the tree holds, complete or not."""
    if not tree or not isinstance(tree, dict):
        return 0
    if _kind(tree) in ("rule", "field"):
        return 1
    return sum(count_rules(child) for child in children_of(tree))


# ---------------------------------------------------------------------------- compile


def compile_tree(tree: dict[str, Any] | None) -> dict | None:
    """Compile a builder tree into one Elasticsearch clause.

    Returns None for an empty or all-incomplete tree, which callers read as "no extra
    narrowing" — a half-built rule in the editor must not blank the results behind it.
    """
    if not tree:
        return None
    if not isinstance(tree, dict):
        raise ValidationFailed("condition_tree must be an object")
    return _compile(tree, depth=0, counter=_Counter())


def _compile(node: dict[str, Any], *, depth: int, counter: _Counter) -> dict | None:
    if depth > MAX_DEPTH:
        raise ValidationFailed(f"Condition groups may nest at most {MAX_DEPTH} deep")
    kind = _kind(node)
    if kind in ("group", "rule_group"):
        conjunction, negated = group_settings(node)
        parts = [c for child in children_of(node) if (c := _compile(child, depth=depth + 1, counter=counter)) is not None]
        if not parts:
            return None
        if len(parts) == 1:
            combined = parts[0]
        elif conjunction == "AND":
            combined = {"bool": {"filter": parts}}
        else:
            combined = {"bool": {"should": parts, "minimum_should_match": 1}}
        return {"bool": {"must_not": [combined]}} if negated else combined
    if kind in ("rule", "field"):
        counter.tick()
        return _compile_rule(node)
    raise ValidationFailed(f"Unknown condition node type {kind!r}")


def _complete(operator: str, values: list[Any]) -> bool:
    if operator in VALUELESS:
        return True
    if operator in RANGE:
        return len(values) == 2 and all(v is not None for v in values)
    return bool(values)


def resolve_rule(node: dict[str, Any]) -> tuple[FieldSpec, str, list[Any]] | None:
    """Validated (spec, canonical operator, values), or None for an unfinished rule."""
    field_name, operator, values = _rule_parts(node)
    if not field_name or not operator:
        return None
    spec = field_spec(field_name)
    canonical = canonical_operator(operator)
    if canonical not in spec.allowed:
        hint = " (metadata is matched exactly; use '=' or 'starts with')" if spec.kind == "metadata" else ""
        raise ValidationFailed(
            f"{spec.label} does not support '{_OPERATOR_TEXT.get(canonical, canonical)}'{hint}",
            details={"field": spec.name, "operator": operator, "allowed": list(spec.operators)},
        )
    if not _complete(canonical, values):
        return None
    return spec, canonical, [_coerce(spec, v) for v in values]


def _coerce(spec: FieldSpec, value: Any) -> Any:
    if spec.kind in ("community", "number"):
        if isinstance(value, bool):
            raise ValidationFailed(f"{spec.label} expects a number")
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise ValidationFailed(f"{spec.label} expects a number, got {value!r}") from exc
        if spec.kind == "community" or number.is_integer():
            return int(number)
        return number
    if spec.kind == "datetime":
        text = str(value).strip()
        if not _DATE.match(text):
            raise ValidationFailed(f"{spec.label} expects a date like 2026-01-31 or 2026-01-31T12:00:00, got {text!r}")
        return text.replace(" ", "T", 1)
    return str(value)


def _escape_wildcard(value: str) -> str:
    return value.replace("\\", "\\\\").replace("*", "\\*").replace("?", "\\?")


def _negate(clause: dict) -> dict:
    return {"bool": {"must_not": [clause]}}


def _compile_rule(node: dict[str, Any]) -> dict | None:
    resolved = resolve_rule(node)
    if resolved is None:
        return None
    spec, op, values = resolved
    es = spec.es_field

    if op == "empty":
        return _negate({"exists": {"field": es}})
    if op == "not_empty":
        return {"exists": {"field": es}}

    if spec.kind == "fulltext":
        query = " ".join(str(v) for v in values)
        if op in ("contains", "not"):
            clause = {"multi_match": {"query": query, "fields": TEXT_FIELDS, "operator": "and"}}
            return clause if op == "contains" else _negate(clause)
        if op == "any":
            return {"multi_match": {"query": query, "fields": TEXT_FIELDS, "operator": "or"}}
        if op == "phrase":
            return {"bool": {"should": [{"match_phrase": {f: query}} for f in TEXT_FIELDS], "minimum_should_match": 1}}
        return {
            "simple_query_string": {
                "query": query, "fields": TEXT_FIELDS, "default_operator": "AND", "flags": "ALL", "lenient": True,
            }
        }

    if op in MULTI:
        clause = {"terms": {es: values}}
        return clause if op == "in" else _negate(clause)
    if op in RANGE:
        low, high = values
        clause = {"range": {es: {"gte": low, "lte": high}}}
        return clause if op == "between" else _negate(clause)
    if op in ("gt", "gte", "lt", "lte"):
        return {"range": {es: {op: values[0]}}}

    value = values[0]
    if op in ("eq", "ne"):
        clause = {"term": {es: value}}
        return clause if op == "eq" else _negate(clause)
    if op == "starts":
        return {"prefix": {es: {"value": value, "case_insensitive": True}}}
    if op in ("contains", "not", "ends"):
        pattern = f"*{_escape_wildcard(value)}" + ("" if op == "ends" else "*")
        clause = {"wildcard": {es: {"value": pattern, "case_insensitive": True}}}
        return _negate(clause) if op == "not" else clause
    raise ValidationFailed(f"Operator {op!r} cannot be applied to {spec.label}")  # pragma: no cover - guarded above


# ---------------------------------------------------------------------------- describe


def describe_tree(tree: dict[str, Any] | None) -> str:
    """The indented, parenthesised rendering the query inspector shows.

    Incomplete rules are omitted exactly as ``compile_tree`` skips them, so the text
    never mentions a rule that did not run.
    """
    if not tree or not isinstance(tree, dict):
        return ""
    return _describe(tree, indent=0, depth=0)


def _describe(node: dict[str, Any], *, indent: int, depth: int) -> str:
    pad = "    " * indent
    kind = _kind(node)
    if kind in ("group", "rule_group"):
        if depth > MAX_DEPTH:
            return f"{pad}…"
        conjunction, negated = group_settings(node)
        described = [
            (child, text)
            for child in children_of(node)
            if (text := _describe(child, indent=indent + 1, depth=depth + 1)).strip()
        ]
        if not described:
            return ""
        if (depth == 0 or len(described) == 1) and not negated:
            # The root, and a bracket around a single condition, add only noise:
            # render the children at this level instead.
            parts = [_describe(child, indent=indent, depth=depth + 1) for child, _ in described]
            return f"\n{pad}{conjunction}\n".join(parts)
        body = f"\n{pad}    {conjunction}\n".join(text for _, text in described)
        return f"{pad}{'NOT ' if negated else ''}(\n{body}\n{pad})"
    if kind in ("rule", "field"):
        try:
            resolved = resolve_rule(node)
        except ValidationFailed:
            return ""
        if resolved is None:
            return ""
        return pad + _describe_rule(*resolved)
    return ""


def _literal(spec: FieldSpec, value: Any) -> str:
    if spec.kind == "community":
        return f"C{value}"
    if spec.kind == "fulltext":
        return f'"{value}"'
    return str(value)


def _describe_rule(spec: FieldSpec, op: str, values: list[Any]) -> str:
    if spec.kind == "community" and op in VALUELESS:
        return f"{spec.label} is {'none' if op == 'empty' else 'set'}"
    if spec.name == "community_version" and op in VALUELESS:
        return "Not clustered yet" if op == "empty" else "Clustered"
    symbol = _OPERATOR_TEXT[op]
    if op in VALUELESS:
        return f"{spec.label} {symbol}"
    if op in RANGE:
        return f"{spec.label} {symbol} {_literal(spec, values[0])} and {_literal(spec, values[1])}"
    if spec.kind == "fulltext":
        return f"{spec.label} {symbol} {_literal(spec, ' '.join(str(v) for v in values))}"
    if op in ("contains", "not", "starts", "ends"):
        return f'{spec.label} {symbol} "{values[0]}"'
    return f"{spec.label} {symbol} {', '.join(_literal(spec, v) for v in values)}"
