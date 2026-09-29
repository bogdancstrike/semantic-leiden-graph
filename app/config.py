"""Runtime configuration.

Every value can be overridden through environment variables (case-insensitive) or a
local ``.env`` file. Secrets use ``SecretStr`` so they never leak into logs, reprs or
the ``/config`` endpoint.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # ------------------------------------------------------------------ Elasticsearch
    es_url: str = "http://localhost:9200"
    es_username: str | None = "elastic"
    es_password: SecretStr | None = SecretStr("changeme-elastic")
    es_api_key: SecretStr | None = None
    es_index: str = "documents"  # alias; physical index is "<alias>-v1"
    es_verify_certs: bool = True
    es_ca_certs: str | None = None
    es_request_timeout: float = 30.0

    # ------------------------------------------------------------------ Qdrant
    qdrant_url: str = "http://localhost:6333"
    qdrant_api_key: SecretStr | None = None
    qdrant_collection: str = "document_vectors"
    qdrant_prefer_grpc: bool = False
    qdrant_timeout: int = 60
    qdrant_quantization: bool = False  # int8 scalar quantization (memory/speed vs tiny recall loss)
    # Qdrant only builds HNSW for segments larger than this (its default is ~10 MB). With
    # 384-dim vectors that leaves corpora of tens of thousands of documents on brute force,
    # which makes the all-documents k-NN linking step O(n^2). 1000 KB: measured 2.6x faster
    # end-to-end on 22k documents (see docs/specs.md §28.1, ADR-009). None = keep Qdrant's default.
    qdrant_indexing_threshold_kb: int | None = Field(default=1000, ge=0)
    qdrant_index_wait_seconds: float = Field(default=180.0, ge=0)
    link_wait_for_index_min_docs: int = Field(default=2000, ge=0)

    # ------------------------------------------------------------------ Neo4j
    neo4j_uri: str = "neo4j://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: SecretStr = SecretStr("password123")
    neo4j_database: str | None = None

    # ------------------------------------------------------------------ Embeddings
    embedding_model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    embedding_device: str | None = None  # "cpu", "cuda", None = auto
    embedding_batch_size: int = Field(default=64, ge=1, le=1024)
    embedding_query_prefix: str = ""  # e.g. "query: " for E5 models
    embedding_document_prefix: str = ""  # e.g. "passage: " for E5 models
    query_cache_size: int = Field(default=2048, ge=0)

    # ------------------------------------------------------------------ Graph policy defaults
    neighbor_k: int = Field(default=12, ge=1, le=200)
    min_similarity: float = Field(default=0.58, ge=-1.0, le=1.0)
    leiden_gamma: float = Field(default=1.0, gt=0.0)
    leiden_random_seed: int = 42
    # A community has at least this many documents; smaller Leiden groups (usually
    # isolated documents, alone in a group of one) are left in no community.
    leiden_min_community_size: int = Field(default=2, ge=2)

    # ------------------------------------------------------------------ Pipeline tuning
    ingest_chunk_size: int = Field(default=256, ge=1, le=10_000)
    neighbor_query_batch: int = Field(default=64, ge=1, le=1_000)
    graph_write_batch: int = Field(default=5_000, ge=100)
    sync_batch_size: int = Field(default=1_000, ge=10)

    # ------------------------------------------------------------------ Limits
    # CSV uploads up to 1 GiB stream to disk and are read in constant memory; the rows
    # limit is a guard against runaway files, not a memory bound.
    upload_max_bytes: int = 1024 * 1024 * 1024
    upload_max_rows: int = 10_000_000
    text_max_chars: int = 20_000
    metadata_max_keys: int = 20
    batch_max_documents: int = 5_000
    search_prefilter_limit: int = 10_000
    job_history: int = 50

    # ------------------------------------------------------------------ API / security
    api_key: SecretStr | None = None  # when set, mutating endpoints require X-API-Key
    cors_origins: str = "http://localhost:3000,http://localhost:5173"
    log_level: str = "INFO"
    startup_attempts: int = 60
    startup_delay_seconds: float = 2.0

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @field_validator("es_password", "es_api_key", "qdrant_api_key", "api_key", mode="before")
    @classmethod
    def _empty_secret_is_none(cls, value):
        return None if value in ("", None) else value

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
