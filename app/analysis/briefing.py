"""Versioned, bounded and cited OSINT briefing contract."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Confidence = Literal["low", "medium", "high"]
Priority = Literal["low", "medium", "high"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Cited(StrictModel):
    evidence_ids: list[str] = Field(min_length=1, max_length=8)


class Assessment(Cited):
    judgment: str = Field(min_length=1, max_length=2000)
    why_it_matters: str = Field(min_length=1, max_length=1500)
    priority: Priority
    priority_reason: str = Field(min_length=1, max_length=1000)
    confidence: Confidence
    confidence_reason: str = Field(min_length=1, max_length=1000)


class Development(Cited):
    headline: str = Field(min_length=1, max_length=200)
    detail: str = Field(min_length=1, max_length=1500)
    reported_time: str | None = Field(default=None, max_length=300)
    actors: list[str] = Field(default_factory=list, max_length=10)
    locations: list[str] = Field(default_factory=list, max_length=10)
    confidence: Confidence


class NarrativeFrame(Cited):
    narrative: str = Field(min_length=1, max_length=1500)
    attribution: str = Field(min_length=1, max_length=800)
    framing: str = Field(min_length=1, max_length=1000)
    confidence: Confidence


class Claim(StrictModel):
    claim: str = Field(min_length=1, max_length=1500)
    status: Literal["reported", "contested", "corroborated_in_dataset", "unresolved"]
    basis: str = Field(min_length=1, max_length=1200)
    confidence: Confidence
    supporting_evidence_ids: list[str] = Field(min_length=1, max_length=8)
    contradicting_evidence_ids: list[str] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def sufficient_evidence(self):
        if self.status == "contested" and not self.contradicting_evidence_ids:
            raise ValueError("Contested claims need contrary evidence")
        if (
            self.status == "corroborated_in_dataset"
            and len(set(self.supporting_evidence_ids)) < 2
        ):
            raise ValueError("Dataset corroboration requires at least two documents")
        return self


class Actor(Cited):
    name: str = Field(min_length=1, max_length=300)
    role: str = Field(min_length=1, max_length=800)
    actions: str = Field(min_length=1, max_length=1200)


class Relationship(Cited):
    from_actor: str = Field(min_length=1, max_length=300)
    to_actor: str = Field(min_length=1, max_length=300)
    relationship: str = Field(min_length=1, max_length=1000)
    confidence: Confidence


class Implication(Cited):
    area: str = Field(min_length=1, max_length=200)
    assessment: str = Field(min_length=1, max_length=1500)
    horizon: str = Field(min_length=1, max_length=300)
    is_inference: bool
    confidence: Confidence


class CollectionGap(Cited):
    question: str = Field(min_length=1, max_length=1000)
    why_it_matters: str = Field(min_length=1, max_length=1000)
    query: str = Field(min_length=1, max_length=300)
    priority: Priority


class WatchIndicator(Cited):
    indicator: str = Field(min_length=1, max_length=300)
    what_to_watch: str = Field(min_length=1, max_length=1000)
    why_it_matters: str = Field(min_length=1, max_length=1000)


class Briefing(StrictModel):
    version: Literal[1] = 1
    assessment: Assessment
    developments: list[Development] = Field(default_factory=list, max_length=8)
    narrative_frames: list[NarrativeFrame] = Field(default_factory=list, max_length=6)
    claims: list[Claim] = Field(default_factory=list, max_length=8)
    actors: list[Actor] = Field(default_factory=list, max_length=10)
    relationships: list[Relationship] = Field(default_factory=list, max_length=8)
    implications: list[Implication] = Field(default_factory=list, max_length=6)
    collection_gaps: list[CollectionGap] = Field(default_factory=list, max_length=6)
    watch_indicators: list[WatchIndicator] = Field(default_factory=list, max_length=6)

    def validate_citations(self, allowed: set[str]):
        def visit(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key.endswith("evidence_ids") and not set(item) <= allowed:
                        raise ValueError("Unknown briefing evidence")
                    visit(item)
            elif isinstance(value, list):
                for item in value:
                    visit(item)

        visit(self.model_dump())


BRIEFING_INSTRUCTIONS = """
Also return briefing, a structured OSINT analyst dossier with version:1. Keep it concise,
prioritized and useful for reviewing a large daily collection. Each listed item MUST cite
1-8 supplied document IDs in evidence_ids, except claims use the two citation lists below.
Aim for 2500-4500 tokens for the complete JSON response. Use 2-4 items per section where supported; empty arrays are valid. Never pad sections.
The briefing object has:
- assessment: judgment (main assessment), why_it_matters, priority [low,medium,high],
  priority_reason, confidence [low,medium,high], confidence_reason, evidence_ids.
  Priority is an investigation recommendation, not a verified threat rating. Explain the
  confidence from coverage, ambiguity and evidence limitations, not numeric probabilities.
- developments: [{headline,detail,reported_time (string or null),actors:[names],
  locations:[names],confidence,evidence_ids}]. Report event time ONLY if the text supplies
  it; preserve relative/uncertain dates. updated_at is collection activity, NEVER event time.
- narrative_frames: [{narrative,attribution,framing,confidence,evidence_ids}]. Attribute
  perspectives and distinguish agreement, competing explanations and emotional framing.
- claims: [{claim,status:[reported,contested,corroborated_in_dataset,unresolved],basis,
  confidence,supporting_evidence_ids:[1-8 IDs],contradicting_evidence_ids:[0-8 IDs]}].
  Contested needs contrary citations. Corroborated_in_dataset needs at least two distinct
  supporting texts; repeated/copy reports do not establish independent corroboration.
  No status means externally verified. Separate allegations from observations.
- actors: [{name,role,actions,evidence_ids}], reflecting explicitly reported roles/actions.
- relationships: [{from_actor,to_actor,relationship,confidence,evidence_ids}], ONLY explicit
  reported relationships. Shared mentions alone do not establish a relationship.
- implications: [{area,assessment,horizon,is_inference:boolean,confidence,evidence_ids}].
  Flag analytical inference true; do not present forecasts or hypothetical harm as facts.
- collection_gaps: [{question,why_it_matters,query,priority,evidence_ids}], with useful
  follow-up search queries of at most 300 characters. Focus on missing facts and alternatives.
- watch_indicators: [{indicator,what_to_watch,why_it_matters,evidence_ids}], observable
  developments that would strengthen, weaken or change the assessment.
The population_profile, when supplied, covers ALL eligible community documents; the documents
array is the selected evidence. Clearly distinguish those scopes. Source labels often represent
CSV imports, NOT publishers or independent sources. Repetition, synchronized update times and
sentiment alone do NOT prove coordination, disinformation, bots, authenticity or attribution.
Do not invent links, quotations, locations, dates, verification or numerical counts. Mention
coverage limitations and alternative explanations. No external investigation was performed.
"""
