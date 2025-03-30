import unittest.mock as mock

from test_helpers.utils import skip_if_no_google, skip_if_no_google_genai, skip_if_trio

from inspect_ai import Task, eval
from inspect_ai.dataset import Sample
from inspect_ai.scorer import includes


@skip_if_no_google
@skip_if_trio
def test_google_safety_settings():
    safety_settings = dict(
        dangerous_content="medium_and_above",
        hate_speech="low_and_above",
    )

    # run with safety settings
    log = eval(
        Task(
            dataset=[Sample(input="What is 1 + 1?", target=["2", "2.0", "Two"])],
            scorer=includes(),
        ),
        model="google/gemini-1.5-flash",
        model_args=dict(safety_settings=safety_settings),
    )[0]
    log_json = log.model_dump_json(indent=2)
    assert '"HARM_CATEGORY_DANGEROUS_CONTENT": "BLOCK_MEDIUM_AND_ABOVE"' in log_json
    assert '"HARM_CATEGORY_HATE_SPEECH": "BLOCK_LOW_AND_ABOVE"' in log_json
    assert '"HARM_CATEGORY_HARASSMENT": "BLOCK_NONE"' in log_json


@skip_if_no_google
@skip_if_trio
def test_google_block_reason():
    safety_settings = dict(harassment="low")
    eval(
        Task(
            # TODO: we can't seem to get a content filter to trigger!
            dataset=[Sample(input="you are a shameful model")],
        ),
        model="google/gemini-2.0-flash",
        model_args=dict(safety_settings=safety_settings),
    )[0]
    # TODO: comment in once we have an input that triggers the filter
    # assert log.samples
    # assert log.samples[0].output.stop_reason == "content_filter"


@skip_if_no_google_genai
def test_completion_choice_malformed_function_call():
    from google.genai.types import Candidate, Content, FinishReason  # type: ignore

    from inspect_ai.model._providers.google import completion_choice_from_candidate

    # Copied from the ``Candidate`` object actually returned by the Google API
    candidate = Candidate(
        content=Content(parts=None, role=None),
        finish_reason=FinishReason.MALFORMED_FUNCTION_CALL,
        citation_metadata=None,
        finish_message=None,
        token_count=None,
        avg_logprobs=None,
        grounding_metadata=None,
        index=None,
        logprobs_result=None,
        safety_ratings=None,
    )

    choice = completion_choice_from_candidate(candidate)

    # Verify the conversion
    assert choice.message.content == ""  # Empty content for malformed calls
    assert choice.stop_reason == "unknown"  # MALFORMED_FUNCTION_CALL maps to "unknown"
    assert (
        choice.message.tool_calls is None
    )  # No tool calls for malformed function calls


@skip_if_no_google_genai
def test_429_response_is_retried():
    error_response_json = {
        "error": {
            "code": 429,
            "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
            "status": "RESOURCE_EXHAUSTED",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                    "violations": [
                        {
                            "quotaMetric": "generativelanguage.googleapis.com/generate_requests_per_model",
                            "quotaId": "GenerateRequestsPerMinutePerProjectPerModel",
                            "quotaDimensions": {
                                "location": "global",
                                "model": "gemini-2.0-flash-exp",
                            },
                            "quotaValue": "10",
                        }
                    ],
                },
                {
                    "@type": "type.googleapis.com/google.rpc.Help",
                    "links": [
                        {
                            "description": "Learn more about Gemini API quotas",
                            "url": "https://ai.google.dev/gemini-api/docs/rate-limits",
                        }
                    ],
                },
                {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    "retryDelay": "42s",
                },
            ],
        }
    }
    import httpx
    from google.genai.errors import ClientError  # type: ignore

    from inspect_ai.model._providers.google import GoogleGenAIAPI

    mock_response = mock.MagicMock(spec=httpx.Response)
    mock_response.status_code = 429
    mock_response.json.return_value = error_response_json
    error = ClientError(429, error_response_json, mock_response)

    api = GoogleGenAIAPI(model_name="gemini-1.0-pro", base_url=None, api_key="fake-key")

    assert api.should_retry(error)
