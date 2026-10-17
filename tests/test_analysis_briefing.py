from copy import deepcopy

import httpx
import pytest

from app.analysis.briefing import Briefing
from app.analysis.llm import LLMClient
from app.errors import DependencyUnavailable
from tests.fakes import make_settings
from tests.test_analysis import CONTENT, EVIDENCE, response_for

BRIEFING = {
    "version": 1,
    "assessment": {
        "judgment": "Funding is the central reported development",
        "why_it_matters": "Station access may improve",
        "priority": "medium",
        "priority_reason": "Monitor delivery commitments",
        "confidence": "low",
        "confidence_reason": "One supplied document; no external verification",
        "evidence_ids": ["a"],
    },
    "developments": [
        {
            "headline": "Station funding announced",
            "detail": "An announcement describes funding.",
            "reported_time": None,
            "actors": ["Rail Agency"],
            "locations": [],
            "confidence": "low",
            "evidence_ids": ["a"],
        }
    ],
    "narrative_frames": [
        {
            "narrative": "Access will improve",
            "attribution": "The announcement",
            "framing": "Investment as progress",
            "confidence": "low",
            "evidence_ids": ["a"],
        }
    ],
    "claims": [
        {
            "claim": "Funding was approved",
            "status": "reported",
            "basis": "One announcement",
            "confidence": "low",
            "supporting_evidence_ids": ["a"],
            "contradicting_evidence_ids": [],
        }
    ],
    "actors": [
        {
            "name": "Rail Agency",
            "role": "Announcing organization",
            "actions": "Reports station funding",
            "evidence_ids": ["a"],
        }
    ],
    "relationships": [],
    "implications": [
        {
            "area": "Transport access",
            "assessment": "Accessible station upgrades may help passengers",
            "horizon": "Delivery period is unknown",
            "is_inference": True,
            "confidence": "low",
            "evidence_ids": ["a"],
        }
    ],
    "collection_gaps": [
        {
            "question": "When will delivery begin?",
            "why_it_matters": "No dates were supplied",
            "query": "railway funding delivery timeline",
            "priority": "medium",
            "evidence_ids": ["a"],
        }
    ],
    "watch_indicators": [
        {
            "indicator": "Delivery milestone",
            "what_to_watch": "A dated implementation announcement",
            "why_it_matters": "Would clarify progress",
            "evidence_ids": ["a"],
        }
    ],
}


@pytest.mark.parametrize("provider", ["gemini", "openai"])
def test_rich_briefing_is_parsed_with_citations_and_legacy_fields(provider):
    content = {**CONTENT, "briefing": BRIEFING}
    llm = LLMClient(
        make_settings(llm_provider=provider, **{f"{provider}_api_key": "test"}),
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json=response_for(provider, content))
        ),
    )
    assert llm.analyze(EVIDENCE) == content
    assert Briefing.model_validate(BRIEFING).assessment.priority == "medium"


@pytest.mark.parametrize(
    "section,field",
    [
        ("assessment", "evidence_ids"),
        ("developments", "evidence_ids"),
        ("narrative_frames", "evidence_ids"),
        ("claims", "supporting_evidence_ids"),
        ("actors", "evidence_ids"),
        ("implications", "evidence_ids"),
        ("collection_gaps", "evidence_ids"),
        ("watch_indicators", "evidence_ids"),
    ],
)
def test_unknown_nested_citations_are_rejected(section, field):
    briefing = deepcopy(BRIEFING)
    item = briefing[section] if section == "assessment" else briefing[section][0]
    item[field] = ["invented"]
    llm = LLMClient(
        make_settings(gemini_api_key="test"),
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                200, json=response_for("gemini", {**CONTENT, "briefing": briefing})
            )
        ),
    )
    with pytest.raises(DependencyUnavailable, match="invalid analysis JSON"):
        llm.analyze(EVIDENCE)


@pytest.mark.parametrize(
    "change",
    [
        "priority",
        "confidence",
        "empty_citations",
        "contested",
        "corroborated",
        "version",
    ],
)
def test_invalid_assessment_and_claim_states_are_rejected(change):
    briefing = deepcopy(BRIEFING)
    if change in ("priority", "confidence"):
        briefing["assessment"][change] = "certain"
    elif change == "empty_citations":
        briefing["assessment"]["evidence_ids"] = []
    elif change == "version":
        briefing["version"] = 99
    else:
        briefing["claims"][0]["status"] = (
            "contested" if change == "contested" else "corroborated_in_dataset"
        )
    with pytest.raises(ValueError):
        Briefing.model_validate(briefing)


def test_relationship_and_contrary_citations_are_checked():
    briefing = deepcopy(BRIEFING)
    briefing["relationships"] = [
        {
            "from_actor": "Rail Agency",
            "to_actor": "Stations",
            "relationship": "Funds upgrades",
            "confidence": "low",
            "evidence_ids": ["invented"],
        }
    ]
    with pytest.raises(ValueError, match="Unknown briefing evidence"):
        Briefing.model_validate(briefing).validate_citations({"a"})
    briefing["relationships"][0]["evidence_ids"] = ["a"]
    briefing["claims"][0]["status"] = "contested"
    briefing["claims"][0]["contradicting_evidence_ids"] = ["invented"]
    with pytest.raises(ValueError, match="Unknown briefing evidence"):
        Briefing.model_validate(briefing).validate_citations({"a"})
