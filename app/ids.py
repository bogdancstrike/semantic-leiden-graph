"""Identity and text normalisation.

External IDs (from the CSV ``id`` column or the API) are the business identity.
Qdrant only accepts UUIDs or unsigned integers as point IDs, so every store uses a
deterministic UUIDv5 derived from the external ID. Consequences:

* the same external ID always maps to the same internal ID in all three stores;
* re-importing a CSV is idempotent (upsert, never duplicate);
* no lookup table is needed to translate between stores.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
import uuid

# Fixed namespace. Changing it would re-key every document, so treat it as a constant.
DOCUMENT_NAMESPACE = uuid.UUID("0b8a4c5e-6a3f-5d0e-9d7c-2f1e8b6a4c10")

_WHITESPACE = re.compile(r"\s+")
_METADATA_KEY = re.compile(r"[^a-z0-9_]+")


def point_id(external_id: str) -> str:
    return str(uuid.uuid5(DOCUMENT_NAMESPACE, external_id))


def normalize_text(text: str) -> str:
    """NFC-normalise and collapse whitespace so trivially different copies hash equally."""
    return _WHITESPACE.sub(" ", unicodedata.normalize("NFC", text)).strip()


def normalize_external_id(value: str) -> str:
    return unicodedata.normalize("NFC", value).strip()


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def content_id(text: str) -> str:
    """Content-addressed external ID for inputs that carry no ID (plain text lines)."""
    return "sha1:" + hashlib.sha1(normalize_text(text).encode("utf-8")).hexdigest()[:20]


def normalize_metadata_key(key: str) -> str:
    return _METADATA_KEY.sub("_", key.strip().lower()).strip("_")[:64]


def is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return False
    return True
