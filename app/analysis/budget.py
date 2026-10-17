"""Pack the largest centrality-ordered prefix using the provider's tokenizer."""

from collections.abc import Callable

from app.errors import DependencyUnavailable


def pack_evidence(
    metadata: dict,
    candidates: Callable[[int], list[dict]],
    total: int,
    count_tokens: Callable[[dict], int],
    context: int,
    output: int,
    margin: int,
):
    budget = context - output - margin
    if budget <= 0:
        raise DependencyUnavailable(
            "LLM context is too small for the output reserve and safety margin."
        )
    measured = {}

    def measure(n):
        if n not in measured:
            docs = candidates(n)
            evidence = {**metadata, "documents": docs}
            measured[n] = count_tokens(evidence)
        return measured[n]

    if measure(0) > budget:
        raise DependencyUnavailable(
            "LLM context is too small for analysis instructions and period metadata."
        )
    low, high = 0, min(32, total)
    # Exponential search avoids loading an arbitrarily large community into memory.
    while high and measure(high) <= budget:
        low = high
        if high == total:
            break
        high = min(high * 2, total)
    while low < high:
        mid = (low + high + 1) // 2
        if measure(mid) <= budget:
            low = mid
        else:
            high = mid - 1
    tokens = measure(low)
    evidence = {**metadata, "documents": candidates(low)}
    if low == 0 and total:
        # A single long central document still gets analyzed as a clearly marked excerpt.
        doc = {**candidates(1)[0], "truncated": True}
        original = doc["text"]
        left, right = 0, len(original)
        while left < right:
            mid = (left + right + 1) // 2
            doc["text"] = original[:mid]
            if count_tokens({**metadata, "documents": [doc]}) <= budget:
                left = mid
            else:
                right = mid - 1
        if left == 0:
            raise DependencyUnavailable(
                "LLM context cannot fit one document with its metadata."
            )
        doc["text"] = original[:left]
        evidence = {**metadata, "documents": [doc]}
        tokens = count_tokens(evidence)
    return evidence, {
        "context_tokens": context,
        "output_reserve": output,
        "safety_margin": margin,
        "input_budget": budget,
        "input_tokens": tokens,
        "selected_documents": len(evidence["documents"]),
    }
