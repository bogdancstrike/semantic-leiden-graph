import json

import httpx
import pytest
import tiktoken

from app.analysis.budget import pack_evidence
from app.analysis.llm import INSTRUCTIONS, LLMClient
from app.errors import DependencyUnavailable
from tests.fakes import make_settings


def test_packs_maximal_ranked_prefix_without_document_count_cap():
    docs = [
        {"id": str(i), "text": "خبر despre infrastructură " * (i % 3 + 1)}
        for i in range(120)
    ]
    count = lambda evidence: (
        len(json.dumps(evidence, ensure_ascii=False).encode("utf-8")) + 100
    )
    target = count({"period": "today", "documents": docs[:83]})
    evidence, budget = pack_evidence(
        {"period": "today"},
        lambda n: docs[:n],
        len(docs),
        count,
        target + 200 + 20,
        200,
        20,
    )
    assert evidence["documents"] == docs[:83]
    assert budget["input_tokens"] == budget["input_budget"]
    assert count({**evidence, "documents": docs[:84]}) > budget["input_budget"]


def test_small_community_includes_every_document():
    docs = [{"id": "a", "text": "one"}, {"id": "b", "text": "two"}]
    evidence, budget = pack_evidence(
        {}, lambda n: docs[:n], 2, lambda e: len(str(e)), 10000, 200, 20
    )
    assert evidence["documents"] == docs
    assert budget["selected_documents"] == 2


def test_oversized_first_document_is_a_marked_maximal_excerpt():
    docs = [{"id": "a", "text": "x" * 1000, "truncated": False}]
    counter = lambda e: len(json.dumps(e))
    evidence, budget = pack_evidence({}, lambda n: docs[:n], 1, counter, 300, 100, 20)
    assert evidence["documents"][0]["truncated"]
    assert 0 < len(evidence["documents"][0]["text"]) < 1000
    assert counter(evidence) == budget["input_budget"]
    assert docs[0]["truncated"] is False  # snapshot candidates are not mutated


@pytest.mark.parametrize("context,output,margin", [(100, 100, 20), (100, 20, 0)])
def test_context_too_small_fails_before_generation(context, output, margin):
    with pytest.raises(DependencyUnavailable, match="too small"):
        pack_evidence({}, lambda n: [], 0, lambda e: 101, context, output, margin)


def test_gemini_discovers_limits_and_counts_system_instruction_and_exact_evidence():
    requests = []

    def handler(request):
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(
                200, json={"inputTokenLimit": 1000000, "outputTokenLimit": 2048}
            )
        return httpx.Response(200, json={"totalTokens": 129})

    llm = LLMClient(
        make_settings(gemini_api_key="secret", llm_context_tokens=10000),
        transport=httpx.MockTransport(handler),
    )
    assert llm.context_limits() == (10000, 2048)
    assert llm.context_limits() == (10000, 2048)
    evidence = {"documents": [{"id": "a", "text": "Știri 世界"}]}
    assert llm.count_tokens(evidence) == 129
    assert len(requests) == 2  # model metadata cached
    assert requests[1].url.path.endswith(":countTokens")
    body = json.loads(requests[1].content)["generateContentRequest"]
    assert body["model"] == "models/gemini-flash-latest"
    assert body["systemInstruction"]["parts"][0]["text"] == INSTRUCTIONS
    assert json.loads(body["contents"][0]["parts"][0]["text"]) == evidence
    assert requests[1].headers["X-goog-api-key"] == "secret"


def test_openai_counts_real_multilingual_tokens_without_remote_requests():
    llm = LLMClient(make_settings(llm_provider="openai", openai_api_key="test"))
    evidence = {"documents": [{"id": "a", "text": "Știri 世界 <|endoftext|>"}]}
    encoding = tiktoken.encoding_for_model("gpt-4.1-mini")
    expected = len(encoding.encode(INSTRUCTIONS, disallowed_special=())) + len(
        encoding.encode(json.dumps(evidence, ensure_ascii=False), disallowed_special=())
    )
    assert llm.count_tokens(evidence) == expected
    assert llm.context_limits() == (1047576, 4096)


def test_unknown_openai_model_requires_explicit_context():
    llm = LLMClient(make_settings(llm_provider="openai", openai_model="custom-model"))
    with pytest.raises(DependencyUnavailable, match="LLM_CONTEXT_TOKENS"):
        llm.context_limits()
    llm.settings.llm_context_tokens = 8192
    assert llm.context_limits() == (8192, 4096)


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"inputTokenLimit": 0, "outputTokenLimit": 100},
        {"inputTokenLimit": "bad", "outputTokenLimit": 100},
    ],
)
def test_malformed_model_limits_fail_safely(body):
    llm = LLMClient(
        make_settings(gemini_api_key="test"),
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body)),
    )
    with pytest.raises(DependencyUnavailable, match="valid model token limits"):
        llm.context_limits()
