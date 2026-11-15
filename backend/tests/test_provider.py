import asyncio
import json
import httpx
import pytest
from openai import AsyncOpenAI
from app.config import settings
from app.models import Assessment, Discoveries
from app.provider import OpenAIProvider, strict_schema


def response(output):
    return {
        "id": "resp_test",
        "object": "response",
        "created_at": 1,
        "status": "completed",
        "model": "gpt-4.1-mini",
        "output": output,
        "usage": {"input_tokens": 200, "output_tokens": 100, "total_tokens": 300},
    }


def message(text):
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


def test_search_forces_tool_validates_sources_and_records_usage(monkeypatch):
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    calls, usage = [], []
    job = dict(
        company="Acme",
        title="PO",
        location="Graz",
        remote_policy="Hybrid",
        austria_remote="unconfirmed",
        availability="confirmed",
        salary=None,
        requirements=[],
        description="Role",
        url="https://acme.test/1",
        source_url="https://acme.test/1",
        published_at=None,
    )

    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        if len(calls) == 1:
            return httpx.Response(
                200,
                json=response(
                    [
                        {
                            "id": "ws_1",
                            "type": "web_search_call",
                            "status": "completed",
                            "action": {
                                "type": "search",
                                "query": "PO Graz",
                                "sources": [{"type": "url", "url": "https://acme.test/1"}],
                            },
                        },
                        message("Acme PO https://acme.test/1"),
                    ]
                ),
            )
        return httpx.Response(
            200,
            json=response(
                [
                    message(
                        json.dumps(
                            {
                                "jobs": [
                                    job,
                                    {**job, "url": "https://invented.test/2"},
                                    {**job, "availability": "closed"},
                                ]
                            }
                        )
                    )
                ]
            ),
        )

    async def check():
        provider = OpenAIProvider(usage.append, lambda: None)
        await provider.client.close()
        provider.client = AsyncOpenAI(
            api_key="test-key", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
        )
        try:
            result = await provider.discover({"sources": ["acme.test"], "max_jobs": 10})
            assert len(result.jobs) == 1
        finally:
            await provider.close()

    asyncio.run(check())
    assert calls[0]["tools"][0]["type"] == "web_search"
    assert calls[0]["tool_choice"] == "required"
    assert calls[0]["tools"][0]["filters"]["allowed_domains"] == ["acme.test"]
    assert calls[1]["text"]["format"]["strict"] is True
    assert all(not c["store"] for c in calls)
    assert len(usage) == 2


def test_strict_schema_and_invalid_assessment():
    for model in (Discoveries, Assessment):
        s = strict_schema(model)
        assert s["additionalProperties"] is False
        for definition in s.get("$defs", {}).values():
            if definition.get("type") == "object":
                assert definition["additionalProperties"] is False
    with pytest.raises(ValueError):
        Assessment(
            score=101,
            reasoning="",
            matching_qualifications=[],
            missing_qualifications=[],
            role_type="realistic",
            decision_authority="",
            development_potential="",
            red_flags=[],
        )
