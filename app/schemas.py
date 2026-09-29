"""Public API contracts (request/response models)."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

# Non-blank after stripping: "   " is rejected with 422 instead of becoming an empty document.
NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

# ---------------------------------------------------------------------------- documents


class DocumentIn(BaseModel):
    id: str | None = Field(default=None, max_length=256, description="External ID; generated from content when omitted")
    text: NonBlank
    metadata: dict[str, str | int | float | bool] | None = None
    source: str | None = Field(default=None, max_length=128)


class TextInput(BaseModel):
    """Backwards-compatible single-document payload (v0.2)."""

    text: NonBlank
    id: str | None = Field(default=None, max_length=256)
    metadata: dict[str, str | int | float | bool] | None = None


class BatchInput(BaseModel):
    """Accepts either the v0.2 ``texts`` list or the v0.3 ``documents`` list."""

    texts: list[NonBlank] | None = None
    documents: list[DocumentIn] | None = None
    source: str | None = Field(default=None, max_length=128)
    cluster: bool = False

    @model_validator(mode="after")
    def _one_of(self) -> BatchInput:
        if not self.texts and not self.documents:
            raise ValueError("Provide 'documents' or 'texts'")
        return self


class DocumentOut(BaseModel):
    id: str
    external_id: str
    text: str
    community_id: int | None = None
    community_version: int | None = None
    source: str | None = None
    length: int | None = None
    metadata: dict[str, Any] | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class IngestReport(BaseModel):
    received: int = 0
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    failed: int = 0
    edges_upserted: int = 0
    documents: list[dict] = Field(default_factory=list, description="Per-document outcome (only for small batches)")
    errors: list[dict] = Field(default_factory=list)


# ---------------------------------------------------------------------------- search


class SearchMode(str, Enum):
    semantic = "semantic"
    keyword = "keyword"
    hybrid = "hybrid"


class ScopeType(str, Enum):
    global_ = "global"
    communities = "communities"
    auto = "auto"


class RoutingStrategy(str, Enum):
    top1 = "top1"
    sum = "sum"
    max = "max"
    mean = "mean"
    softmax = "softmax"


class FusionMethod(str, Enum):
    rrf = "rrf"
    dbsf = "dbsf"


class Scope(BaseModel):
    type: ScopeType = ScopeType.global_
    community_ids: list[int] = Field(default_factory=list, max_length=100)
    exclude_community_ids: list[int] = Field(default_factory=list, max_length=100)


class RoutingOptions(BaseModel):
    strategy: RoutingStrategy = RoutingStrategy.sum
    anchors: int = Field(default=20, ge=1, le=200)
    communities: int = Field(default=1, ge=1, le=10, description="How many top communities to search")
    temperature: float = Field(default=0.05, gt=0.0, le=5.0)
    min_share: float = Field(default=0.0, ge=0.0, le=1.0, description="Drop communities below this vote share")


class FusionOptions(BaseModel):
    method: FusionMethod = FusionMethod.rrf
    alpha: float = Field(default=0.5, ge=0.0, le=1.0, description="Weight of the semantic list (1-alpha = keyword)")
    rrf_k: int = Field(default=60, ge=1, le=1000)
    candidates: int = Field(default=0, ge=0, le=1000, description="Per-engine candidate depth; 0 = auto")


class LexicalOptions(BaseModel):
    syntax: Literal["plain", "advanced"] = "plain"
    operator: Literal["or", "and"] = "or"
    fuzzy: bool = False
    phrase_boost: bool = True
    minimum_should_match: str | None = Field(default=None, max_length=16, pattern=r"^-?\d{1,3}%?$")


class MMROptions(BaseModel):
    enabled: bool = False
    lambda_: float = Field(default=0.7, ge=0.0, le=1.0, alias="lambda")
    candidates: int = Field(default=50, ge=2, le=500)

    model_config = ConfigDict(populate_by_name=True)


class SearchFilters(BaseModel):
    """Predicates. Everything except community lives in Elasticsearch only."""

    must_text: str | None = Field(default=None, max_length=1000, description="simple_query_string that results must satisfy")
    exclude_text: str | None = Field(default=None, max_length=1000)
    length_min: int | None = Field(default=None, ge=0)
    length_max: int | None = Field(default=None, ge=0)
    sources: list[str] = Field(default_factory=list, max_length=50)
    metadata: dict[str, str] = Field(default_factory=dict, max_length=20)
    updated_after: datetime | None = None
    updated_before: datetime | None = None
    unassigned_only: bool = False
    condition_tree: dict[str, Any] | None = Field(
        default=None,
        description="react-awesome-query-builder JSON tree (see /explore/fields); compiled to an ES filter",
    )

    def has_es_only_predicates(self) -> bool:
        # Imported here: app.search.conditions is pure, but importing it at module
        # level would make every schema import pull the search package.
        from app.search.conditions import compile_tree

        if self.condition_tree and compile_tree(self.condition_tree) is not None:
            return True
        return bool(
            self.must_text
            or self.exclude_text
            or self.length_min is not None
            or self.length_max is not None
            or self.sources
            or self.metadata
            or self.updated_after
            or self.updated_before
        )


class SearchRequest(BaseModel):
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    mode: SearchMode = SearchMode.semantic
    top_k: int = Field(default=10, ge=1, le=200)
    min_score: float | None = Field(default=None, ge=-1.0, le=1.0, description="Cosine floor for the semantic list")
    scope: Scope = Field(default_factory=Scope)
    routing: RoutingOptions = Field(default_factory=RoutingOptions)
    fusion: FusionOptions = Field(default_factory=FusionOptions)
    lexical: LexicalOptions = Field(default_factory=LexicalOptions)
    mmr: MMROptions = Field(default_factory=MMROptions)
    filters: SearchFilters = Field(default_factory=SearchFilters)
    highlight: bool = True
    facets: bool = True
    explain: bool = True

    # v0.2 compatibility: {"community_id": 7}
    community_id: int | None = Field(default=None, description="Deprecated: use scope")

    @model_validator(mode="after")
    def _legacy(self) -> SearchRequest:
        if self.community_id is not None and self.scope.type == ScopeType.global_:
            self.scope = Scope(type=ScopeType.communities, community_ids=[self.community_id])
        if self.scope.type == ScopeType.communities and not self.scope.community_ids:
            raise ValueError("scope.type=communities requires scope.community_ids")
        return self


class HitExplain(BaseModel):
    semantic_rank: int | None = None
    semantic_score: float | None = None
    keyword_rank: int | None = None
    keyword_score: float | None = None
    fused_score: float | None = None
    mmr_rank: int | None = None


class SearchHit(BaseModel):
    id: str
    external_id: str | None = None
    text: str
    score: float
    community_id: int | None = None
    source: str | None = None
    metadata: dict[str, Any] | None = None
    highlights: list[str] = Field(default_factory=list)
    explain: HitExplain | None = None


class RoutingCandidate(BaseModel):
    community_id: int
    support: float
    share: float
    anchors: int
    best_score: float


class RoutingResult(BaseModel):
    strategy: RoutingStrategy
    selected: list[int]
    candidates: list[RoutingCandidate]
    anchor_document_id: str | None = None
    anchor_score: float | None = None


class FacetBucket(BaseModel):
    value: int | str | None
    count: int


class SearchResponse(BaseModel):
    mode: SearchMode
    results: list[SearchHit]
    total_lexical: int | None = None
    routing: RoutingResult | None = None
    facets: dict[str, list[FacetBucket]] = Field(default_factory=dict)
    facet_source: Literal["keyword", "candidates", "none"] = "none"
    timings: dict[str, float] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)

    # v0.2 compatibility for /search/community consumers
    community_id: int | None = None
    anchor_document_id: str | None = None
    anchor_score: float | None = None


# ---------------------------------------------------------------------------- graph / clustering


class DeleteSourceRequest(BaseModel):
    source: str | None = Field(..., max_length=128, description="Source label; null = documents without a source")
    cluster: bool = Field(default=False, description="Re-run Leiden after the delete")


class ClusterRequest(BaseModel):
    gamma: float | None = Field(default=None, gt=0.0, le=50.0)
    random_seed: int | None = None
    min_community_size: int | None = Field(
        default=None, ge=2, le=100_000, description="Smallest group that counts as a community (default: the last run's, else LEIDEN_MIN_COMMUNITY_SIZE)"
    )


class RebuildRequest(BaseModel):
    neighbor_k: int | None = Field(default=None, ge=1, le=200)
    min_similarity: float | None = Field(default=None, ge=-1.0, le=1.0)
    cluster: bool = True


class GraphPolicy(BaseModel):
    neighbor_k: int
    min_similarity: float
    updated_at: datetime | None = None


class GraphNode(BaseModel):
    id: str
    community_id: int | None = None
    external_id: str | None = None
    text: str = ""


class GraphLink(BaseModel):
    source: str
    target: str
    score: float


class GraphOut(BaseModel):
    nodes: list[GraphNode]
    links: list[GraphLink]


class GraphQueryRequest(BaseModel):
    """Seed a subgraph from a question: a ranked search, a condition tree, or both."""

    query: str = Field(default="", max_length=2000, description="Empty = seed by conditions only (newest first)")
    mode: SearchMode = SearchMode.hybrid
    condition_tree: dict[str, Any] | None = None
    limit: int = Field(default=150, ge=1, le=1000, description="Seed documents (ranked search is capped at 200)")
    expand: bool = Field(default=False, description="Add the strongest 1-hop neighbours of the seeds")
    neighbor_limit: int = Field(default=300, ge=0, le=2000)
    min_score: float = Field(default=0.0, ge=-1.0, le=1.0)
    max_score: float = Field(default=1.0, ge=-1.0, le=1.0, description="Hide edges above this similarity (e.g. near-duplicates)")

    @model_validator(mode="after")
    def _band(self) -> GraphQueryRequest:
        if self.max_score < self.min_score:
            raise ValueError("max_score must be greater than or equal to min_score")
        return self


class GraphSeed(BaseModel):
    id: str
    rank: int
    score: float | None = None


class GraphQueryOut(GraphOut):
    seeds: list[GraphSeed]
    matched: int
    condition_text: str = ""
    warnings: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------- explore

ExploreSort = Literal["updated_at", "created_at", "length", "external_id", "community_id", "source", "_score"]
EXPLORE_WINDOW = 10_000  # index.max_result_window: offset paging cannot reach past it


class ExploreRequest(BaseModel):
    """One question over the corpus: a quick text filter plus a condition tree."""

    query_text: str = Field(default="", max_length=500)
    condition_tree: dict[str, Any] | None = None
    sort: ExploreSort = "updated_at"
    order: Literal["asc", "desc"] = "desc"
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=25, ge=1, le=200)
    facets: bool = False
    highlight: bool = True


# ---------------------------------------------------------------------------- jobs


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"


class JobOut(BaseModel):
    id: str
    kind: str
    status: JobStatus
    phase: str
    processed: int
    total: int | None
    message: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
