from app.analysis.entities import entity_statistics


def test_entity_counts_mentions_documents_sources_dates_and_shared_documents():
    entities = [
        {"name": "Rail Agency", "label": "ORG", "evidence_ids": ["a"]},
        {"name": "Cluj", "label": "LOCATION", "evidence_ids": ["a"]},
        {"name": "Missing Name", "label": "PERSON", "evidence_ids": ["a"]},
    ]
    docs = [
        {
            "id": "a",
            "external_id": "news-a",
            "source": "desk-a",
            "updated_at": "2026-10-17T02:00:00+03:00",
            "text": "Rail Agency announces funding in Cluj. RAIL AGENCY confirms.",
            "truncated": True,
        },
        {
            "id": "b",
            "source": "desk-b",
            "updated_at": "2026-10-18T00:00:00Z",
            "text": "Rail Agency issues another update.",
        },
        {
            "id": "c",
            "source": "desk-a",
            "text": "Rail Agencywide and SuperCluj are different names.",
        },
    ]
    result = entity_statistics({"entities": entities}, docs)
    rail, cluj, missing = result["entities"]
    assert result["scope"] == "analyzed_evidence"
    assert result["documents"] == 3 and result["documents_with_entities"] == 2
    assert result["truncated_documents"] == 1 and result["mentions"] == 4
    assert rail["mention_count"] == 3 and rail["document_count"] == 2
    assert rail["document_share_percent"] == 66.7
    assert rail["first_updated_at"] == "2026-10-16T23:00:00+00:00"
    assert rail["last_updated_at"] == "2026-10-18T00:00:00+00:00"
    assert rail["timeline"] == [
        {"date": "2026-10-16", "documents": 1, "mentions": 2},
        {"date": "2026-10-18", "documents": 1, "mentions": 1},
    ]
    assert rail["sources"] == [
        {"source": "desk-a", "documents": 1, "mentions": 2},
        {"source": "desk-b", "documents": 1, "mentions": 1},
    ]
    assert rail["co_occurrences"] == [
        {"name": "Cluj", "label": "LOCATION", "document_count": 1}
    ]
    assert (
        rail["examples"][0]["id"] == "a"
        and "Rail Agency" in rail["examples"][0]["text"]
    )
    assert cluj["document_count"] == 1
    assert missing["mention_count"] == 0 and missing["examples"] == []


def test_entity_matching_normalizes_unicode_whitespace_and_escapes_punctuation():
    result = entity_statistics(
        {
            "entities": [
                {"name": "Căi Ferate", "label": "ORG", "evidence_ids": ["a"]},
                {"name": "A+B", "label": "ORG", "evidence_ids": ["a"]},
            ]
        },
        [
            {
                "id": "a",
                "text": "CĂI\n  FERATE and A+B. AAAB is not A+B.",
                "updated_at": "invalid",
            }
        ],
    )
    assert [row["mention_count"] for row in result["entities"]] == [1, 2]
    assert result["entities"][0]["first_updated_at"] is None
    assert result["entities"][0]["sources"][0]["source"] is None
    assert entity_statistics({}, [])["mentions"] == 0
