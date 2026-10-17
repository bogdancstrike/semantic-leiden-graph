from app.analysis.candidates import Candidates


def test_population_profile_uses_full_scope_and_preserves_unknown_dates():
    with Candidates() as candidates:
        for doc in [
            {
                "id": "a",
                "text": "same excerpt",
                "source": "wire",
                "updated_at": "2026-10-17T02:00:00+03:00",
                "strength": 5,
            },
            {
                "id": "b",
                "text": "same excerpt",
                "source": "wire",
                "updated_at": "2026-10-17T00:00:00Z",
                "strength": 2,
            },
            {
                "id": "c",
                "text": "same excerpt",
                "source": "import",
                "updated_at": "invalid",
                "strength": 1,
            },
        ]:
            # First two are full-text duplicates, third merely shares the same excerpt prefix.
            candidates.add(
                1,
                doc,
                fingerprint="repeated" if doc["id"] != "c" else "different-full-text",
            )
        candidates.add(2, {"id": "other", "text": "other", "strength": 1})
        result = candidates.profile(1)
        assert result["documents"] == 3 and result["unique_texts"] == 2
        assert result["repeated_documents"] == 1 and result["duplicate_groups"] == 1
        assert result["source_labels"] == 2 and result["sources"][0] == {
            "source": "wire",
            "documents": 2,
        }
        assert result["activity_unit"] == "hour" and result["unknown_updated_at"] == 1
        assert sum(b["documents"] for b in result["activity"]) == 2
        assert result["first_updated_at"] == "2026-10-16T23:00:00+00:00"
        assert result["repetition_examples"][0]["documents"] == 2
        assert result["repetition_examples"][0]["id"] == "a"
        assert (
            len(candidates.prefix(1, 1)) == 1
        )  # Profile has all 3, beyond selected evidence.


def test_profile_over_100k_documents_stays_bounded():
    with Candidates() as candidates:
        for i in range(100000):
            candidates.add(
                7,
                {
                    "id": str(i),
                    "text": f"story {i % 10}",
                    "source": f"feed-{i % 30}",
                    "updated_at": f"2026-{i % 12 + 1:02d}-01T12:00:00Z",
                    "strength": 1,
                },
            )
        result = candidates.profile(7)
        assert result["documents"] == 100000
        assert result["unique_texts"] == 10 and result["repeated_documents"] == 99990
        assert result["source_labels"] == 30 and len(result["sources"]) == 20
        assert (
            result["other_source_documents"]
            + sum(s["documents"] for s in result["sources"])
            == 100000
        )
        assert len(result["activity"]) <= 96 and result["activity_unit"] == "month"
        assert len(result["repetition_examples"]) == 3
        assert result["repetition_examples"][0]["documents"] == 10000
