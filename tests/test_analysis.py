import json

import httpx
import pytest

from app.analysis.llm import LLMClient
from app.analysis.store import AnalysisStore
from app.errors import DependencyUnavailable
from tests.fakes import make_settings

CONTENT = {
    "title": "Rail investment",
    "summary": "Stations receive funding.",
    "key_findings": ["Funding increased"],
    "uncertainties": ["Only two samples"],
    "evidence_ids": ["a"],
    "narratives": ["Infrastructure investment improves access"],
    "sentiment": "positive",
    "sentiment_reasoning": "The reporting describes expanded access.",
    "classifications": ["transport", "infrastructure"],
    "entities": [],
}
EVIDENCE = {"documents": [{"id": "a", "text": "Railway stations receive funding."}]}


def response_for(provider, content=CONTENT):
    output = json.dumps(content)
    if provider == "gemini":
        return {
            "candidates": [
                {"finishReason": "STOP", "content": {"parts": [{"text": output}]}}
            ]
        }
    return {
        "status": "completed",
        "output": [
            {"type": "reasoning", "summary": []},
            {"type": "message", "content": [{"type": "output_text", "text": output}]},
        ],
    }


@pytest.mark.parametrize("provider", ["gemini", "openai"])
def test_provider_sends_document_content_and_parses_json(provider):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=response_for(provider))

    settings = make_settings(
        llm_provider=provider, **{f"{provider}_api_key": "private-test-key"}
    )
    llm = LLMClient(settings, transport=httpx.MockTransport(handler))
    assert llm.analyze(EVIDENCE) == CONTENT
    request = requests[0]
    body = json.loads(request.content)
    if provider == "gemini":
        assert str(request.url).endswith("/models/gemini-flash-latest:generateContent")
        assert request.headers["X-goog-api-key"] == "private-test-key"
        assert json.loads(body["contents"][0]["parts"][0]["text"]) == EVIDENCE
        assert body["generationConfig"]["responseMimeType"] == "application/json"
    else:
        assert str(request.url) == "https://api.openai.com/v1/responses"
        assert request.headers["Authorization"] == "Bearer private-test-key"
        assert body["store"] is False
        assert json.loads(body["input"]) == EVIDENCE


@pytest.mark.parametrize("status,attempts", [(429, 3), (503, 3), (401, 1), (400, 1)])
def test_provider_retries_only_transient_errors_and_redacts_secrets(status, attempts):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(status, text="private-test-key confidential document")

    llm = LLMClient(
        make_settings(gemini_api_key="private-test-key"),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
    )
    with pytest.raises(DependencyUnavailable) as error:
        llm.analyze(EVIDENCE)
    assert len(requests) == attempts
    assert "private-test-key" not in str(error.value)
    assert "confidential" not in str(error.value)


def test_transient_failure_then_success():
    responses = iter(
        [httpx.Response(429), httpx.Response(200, json=response_for("gemini"))]
    )
    llm = LLMClient(
        make_settings(gemini_api_key="test"),
        transport=httpx.MockTransport(lambda _: next(responses)),
        sleep=lambda _: None,
    )
    assert llm.analyze(EVIDENCE) == CONTENT


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"candidates": []},
        {"candidates": [{"finishReason": "MAX_TOKENS"}]},
        response_for("gemini", {**CONTENT, "evidence_ids": ["invented"]}),
        response_for("gemini", {"title": "bad"}),
    ],
)
def test_provider_rejects_blocked_incomplete_and_ungrounded_output(body):
    llm = LLMClient(
        make_settings(gemini_api_key="test"),
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body)),
    )
    with pytest.raises(DependencyUnavailable, match="invalid analysis JSON"):
        llm.analyze(EVIDENCE)


def test_timeout_retries_without_leaking_request():
    def handler(request):
        raise httpx.ReadTimeout("secret", request=request)

    llm = LLMClient(
        make_settings(gemini_api_key="secret"),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
    )
    with pytest.raises(DependencyUnavailable, match="timed out") as error:
        llm.analyze(EVIDENCE)
    assert "secret" not in str(error.value)


def test_missing_key_never_makes_a_request():
    llm = LLMClient(make_settings(gemini_api_key=None))
    with pytest.raises(DependencyUnavailable, match="GEMINI_API_KEY"):
        llm.analyze(EVIDENCE)


def test_reports_and_schedule_survive_restart(tmp_path):
    path = str(tmp_path / "state" / "analysis.sqlite3")
    store = AnalysisStore(path)
    store.save(
        {
            "id": "first",
            "created_at": "2026-10-17T10:00:00+00:00",
            "status": "succeeded",
            "communities": [{"documents": ["a"]}],
        }
    )
    store.save(
        {
            "id": "interrupted",
            "created_at": "2026-10-17T11:00:00+00:00",
            "status": "running",
        }
    )
    store.set_due("2026-10-18T10:00:00+00:00")
    store.close()
    store = AnalysisStore(path)
    store.recover_interrupted()
    assert store.get("first")["communities"][0]["documents"] == ["a"]
    assert store.get("interrupted")["status"] == "failed"
    assert "restarted" in store.get("interrupted")["error"]
    assert store.list(1)["runs"][0]["id"] == "interrupted"
    assert store.list(1, 1)["runs"][0]["id"] == "first"
    assert "communities" not in store.list(1, 1)["runs"][0]
    assert store.list()["total"] == 2
    assert store.due() == "2026-10-18T10:00:00+00:00"
    store.close()


@pytest.mark.parametrize("provider", ["gemini", "openai"])
@pytest.mark.parametrize("status", [401, 403, 429, 503])
def test_multiple_keys_fail_over_and_remember_working_key(provider, status):
    used = []

    def handler(request):
        key = request.headers.get("X-goog-api-key") or request.headers[
            "Authorization"
        ].removeprefix("Bearer ")
        used.append(key)
        return httpx.Response(
            status if key == "first-private" else 200, json=response_for(provider)
        )

    llm = LLMClient(
        make_settings(
            llm_provider=provider,
            **{f"{provider}_api_key": "first-private, second-private"},
        ),
        transport=httpx.MockTransport(handler),
        sleep=lambda _: None,
    )
    assert llm.analyze(EVIDENCE) == CONTENT
    assert used == ["first-private", "second-private"]
    llm.analyze(EVIDENCE)
    assert used[-1] == "second-private"


def test_all_rejected_keys_fail_without_leaking_them():
    used = []

    def handler(request):
        used.append(request.headers["X-goog-api-key"])
        return httpx.Response(403, text="first-private second-private")

    llm = LLMClient(
        make_settings(gemini_api_key="first-private,second-private"),
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(DependencyUnavailable) as error:
        llm.analyze(EVIDENCE)
    assert len(used) == 2
    assert "private" not in str(error.value)


def test_named_entity_citations_must_reference_supplied_documents():
    content = {
        **CONTENT,
        "entities": [
            {"name": "Example Agency", "label": "ORG", "evidence_ids": ["invented"]}
        ],
    }
    llm = LLMClient(
        make_settings(gemini_api_key="test"),
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json=response_for("gemini", content))
        ),
    )
    with pytest.raises(DependencyUnavailable, match="invalid analysis JSON"):
        llm.analyze(EVIDENCE)
