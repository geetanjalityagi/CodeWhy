from __future__ import annotations

import json
import logging
import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Final, Optional, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from app.config import Settings, settings

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class LLMProviderError(RuntimeError):
    """Base error for LLM provider operations."""
    pass


class TokenBudgetExhaustedError(LLMProviderError):
    """Raised when an LLM operation would exceed or exceeds the allotted token budget."""

    def __init__(self, limit: int, used: int, requested: int = 0):
        super().__init__(
            f"LLM token budget exhausted: limit={limit}, used={used}, "
            f"requested={requested}. Stopping run."
        )
        self.limit = limit
        self.used = used
        self.requested = requested


class LLMTimeoutError(LLMProviderError):
    """Raised when an LLM call exceeds the configured timeout."""
    pass


class LLMSchemaValidationError(LLMProviderError):
    """Raised when an LLM response fails validation against the expected Pydantic schema.

    Carries the top-level key names that arrived and the finish reason, because a
    caller that drops the reply has to be able to say what it dropped. Values are
    never carried: the reply may contain untrusted text.
    """

    def __init__(
        self,
        raw_content: str,
        errors: Any,
        received_keys: Optional[list[str]] = None,
        finish_reason: str = "",
    ) -> None:
        super().__init__(f"LLM output failed Pydantic schema validation: {errors}")
        self.raw_content = raw_content
        self.validation_errors = errors
        self.received_keys = list(received_keys or [])
        self.finish_reason = finish_reason
        #: Short description of what was wrong, for the operator.
        self.reason = _describe_validation_failure(errors)


class LLMNonRetryableError(LLMProviderError):
    """Raised for a status that must not be retried.

    The retry loop catches every other exception to try again, so this type exists
    purely to escape that loop: a 400, 401, 403 or 404 fails the same way every
    time, and repeating the call only turns a clear error into a slow one.
    """

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def _describe_validation_failure(errors: Any) -> str:
    """A short phrase naming the mismatch, with no values from the reply."""
    entries = errors if isinstance(errors, list) else [{"loc": (), "type": str(errors)}]
    parts: list[str] = []
    for entry in entries[:4]:
        if not isinstance(entry, dict):
            parts.append(str(entry))
            continue
        location = ".".join(str(part) for part in entry.get("loc", ()))
        kind = entry.get("type", "invalid")
        parts.append(f"{location or '(top level)'}: {kind}")
    return "; ".join(parts) or "did not match the schema"


class LLMEmptyReplyError(LLMProviderError):
    """Raised when the model returned no text at all.

    A 200 with empty content is not a success and not a transient outage, so it is
    reported as its own failure rather than retried through the backoff schedule.
    """

    def __init__(
        self,
        finish_reason: str,
        *,
        prompt_tokens: int,
        completion_tokens: int,
        reasoning_present: bool,
        reasoning_tokens: int,
        retried: bool,
    ) -> None:
        self.finish_reason = finish_reason
        self.reasoning_present = reasoning_present
        self.reasoning_tokens = reasoning_tokens
        self.retried = retried

        detail = (
            f"finish_reason={finish_reason or 'unknown'} "
            f"prompt_tokens={prompt_tokens} completion_tokens={completion_tokens}"
        )
        if reasoning_present or reasoning_tokens:
            detail += f" reasoning_tokens={reasoning_tokens}"

        # The two cases below are worded so the phrase a reader greps for is
        # identical either way: this is always an output-limit problem.
        if finish_reason == "length":
            reason = (
                "output limit consumed by reasoning: the model spent the budget "
                "without producing visible text"
            )
        else:
            reason = "output limit consumed with no visible text produced"

        super().__init__(
            f"LLM returned no text ({detail}); retried={retried}; {reason}. "
            "Raise LLM_MAX_OUTPUT_TOKENS if the model is reasoning at length."
        )
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens


# ---------------------------------------------------------------------------
# Token Budget Guard
# ---------------------------------------------------------------------------

@dataclass
class TokenBudget:
    """Tracks token consumption for an execution run and enforces MAX_LLM_TOKENS_PER_RUN."""

    max_tokens: int = field(default_factory=lambda: settings.max_llm_tokens_per_run)
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @property
    def remaining(self) -> int:
        return max(0, self.max_tokens - self.total_tokens)

    @property
    def is_exhausted(self) -> bool:
        return self.total_tokens >= self.max_tokens

    def can_afford(self, estimated_tokens: int = 0) -> bool:
        """Returns True if the budget has room for estimated_tokens."""
        return (self.total_tokens + estimated_tokens) <= self.max_tokens

    def consume(self, prompt_tokens: int, completion_tokens: int) -> None:
        """Records token usage and raises TokenBudgetExhaustedError if the limit is exceeded."""
        requested = prompt_tokens + completion_tokens
        if self.total_tokens + requested > self.max_tokens:
            # Still record what we tried to consume for auditability
            self.prompt_tokens += prompt_tokens
            self.completion_tokens += completion_tokens
            raise TokenBudgetExhaustedError(
                limit=self.max_tokens,
                used=self.total_tokens,
                requested=requested,
            )
        self.prompt_tokens += prompt_tokens
        self.completion_tokens += completion_tokens

    def summary(self) -> dict[str, Any]:
        return {
            "max_tokens": self.max_tokens,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "remaining": self.remaining,
            "exhausted": self.is_exhausted,
        }


# ---------------------------------------------------------------------------
# The two `response_format` shapes, named so a log line can say which was used.
# Declared before LLMResponse, which carries one as a default.
# ---------------------------------------------------------------------------

RESPONSE_FORMAT_JSON_OBJECT: Final[str] = "json_object"
RESPONSE_FORMAT_JSON_SCHEMA: Final[str] = "json_schema"


# ---------------------------------------------------------------------------
# Response Model
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class LLMResponse:
    """Encapsulates the text completion, token metrics, and metadata."""

    content: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    model: str
    status_code: int = 200
    #: True only when the server actually reported usage. Estimated fallback values
    #: never count as reported.
    usage_reported: bool = False
    #: Why the model stopped: "stop", "length", "tool_calls", or "" when absent.
    finish_reason: str = ""
    #: True when the reply carried a reasoning field, which means tokens were spent
    #: thinking even though the visible reply is what matters.
    reasoning_present: bool = False
    #: Which `response_format` the endpoint actually accepted, so a run can be
    #: audited without guessing whether the strict form was honoured.
    response_format_mode: str = RESPONSE_FORMAT_JSON_OBJECT
    raw_response: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Retry policy
# ---------------------------------------------------------------------------

#: Transient upstream conditions. A provider overloaded or briefly down answers with
#: one of these, and the same request usually succeeds later, so they are retried.
RETRYABLE_STATUSES: Final[frozenset[int]] = frozenset({429, 500, 502, 503, 504})

#: Client-side mistakes. Retrying cannot change the answer: the request, the
#: credentials or the model name is wrong, so the call fails immediately and the
#: message is surfaced instead of being buried under minutes of waiting.
NON_RETRYABLE_STATUSES: Final[frozenset[int]] = frozenset({400, 401, 403, 404})

#: One wait after each retry, so six retries use six different pauses. The last two
#: are equal on purpose: a long outage needs patience, not a growing delay.
RETRY_BACKOFF_SECONDS: Final[tuple[int, ...]] = (5, 15, 30, 60, 120, 120)

#: Attempts allowed per call: the first try plus one per backoff step.
MAX_ATTEMPTS: Final[int] = len(RETRY_BACKOFF_SECONDS) + 1


def _retry_after_seconds(response: httpx.Response) -> Optional[float]:
    """Seconds the server asked us to wait, from its Retry-After header.

    Only the delta-seconds form is honoured; an HTTP-date is ignored rather than
    guessed at, because the request is about to be sent anyway and a wrong delay
    is worse than the default schedule.
    """
    raw = response.headers.get("Retry-After")
    if not raw:
        return None
    try:
        value = float(raw.strip())
    except ValueError:
        return None
    return value if value >= 0 else None


# ---------------------------------------------------------------------------
# Abstract LLM Provider
# ---------------------------------------------------------------------------

class BaseLLMProvider(ABC):
    #: True only for a provider that calls a real model. A mock must keep this
    #: False so any response built with it can declare itself a fixture.
    is_real: bool = True

    """Abstract interface for LLM providers."""

    def __init__(
        self,
        budget: Optional[TokenBudget] = None,
        timeout_s: Optional[int] = None,
        max_retries: int = MAX_ATTEMPTS,
    ) -> None:
        self.budget = budget or TokenBudget()
        self.timeout_s = timeout_s if timeout_s is not None else settings.llm_timeout_s
        self.max_retries = max_retries

    @abstractmethod
    def complete(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 2048,
        response_json_schema: Optional[dict[str, Any]] = None,
    ) -> LLMResponse:
        """Execute a text completion, tracking token budget and retries."""
        ...

    def complete_structured(
        self,
        schema: type[T],
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 2048,
        response_json_schema: Optional[dict[str, Any]] = None,
    ) -> tuple[T, LLMResponse]:
        """Calls the LLM expecting JSON output, parses it, and validates against a Pydantic model.

        Extracts JSON from markdown fences if the model wraps it in ```json ... ```.
        """
        response = self.complete(
            prompt=prompt,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
            response_json_schema=response_json_schema,
        )

        raw = response.content.strip()
        # Strip potential markdown fences
        fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw)
        json_str = fence_match.group(1).strip() if fence_match else raw

        received_keys: list[str] = []
        try:
            parsed_json = json.loads(json_str)
        except json.JSONDecodeError as exc:
            raise LLMSchemaValidationError(
                raw_content=raw,
                errors=f"JSON parsing error: {exc}",
                received_keys=[],
                finish_reason=response.finish_reason,
            ) from exc
        if isinstance(parsed_json, dict):
            # Key names only. The values may be untrusted repository text.
            received_keys = [str(key) for key in parsed_json]

        try:
            validated = schema.model_validate(parsed_json)
            return validated, response
        except ValidationError as exc:
            raise LLMSchemaValidationError(
                raw_content=raw,
                errors=exc.errors(),
                received_keys=received_keys,
                finish_reason=response.finish_reason,
            ) from exc


# ---------------------------------------------------------------------------
# Mock / Local LLM Provider (for tests and offline local runs)
# ---------------------------------------------------------------------------

def _redact(value: object) -> str:
    """Never let a credential reach an error message."""
    text = str(value)
    for secret in (settings.llm_api_key, settings.github_token, settings.neo4j_password):
        if secret and len(secret) >= 8 and secret in text:
            text = text.replace(secret, "<redacted>")
    return text


def _safe_error_body(response: httpx.Response, limit: int = 400) -> str:
    """A short excerpt of an error body, with anything that looks like a key removed."""
    try:
        body = response.text
    except Exception:  # noqa: BLE001
        return "<no body>"
    body = " ".join(body.split())[:limit]
    return _redact(body) or "<empty body>"


class MockLLMProvider(BaseLLMProvider):
    is_real: bool = False

    """Mock provider with canned responses, customizable completion handler, and token tracking."""

    #: Recorded so a test can assert which response_format was asked for.
    requested_json_schema: Optional[dict[str, Any]] = None

    def __init__(
        self,
        canned_response: Optional[str] = None,
        response_factory: Optional[Callable[[str, Optional[str]], str]] = None,
        budget: Optional[TokenBudget] = None,
        timeout_s: Optional[int] = None,
        tokens_per_call: int = 150,
    ) -> None:
        super().__init__(budget=budget, timeout_s=timeout_s)
        self.canned_response = canned_response or "{}"
        self.response_factory = response_factory
        self.tokens_per_call = tokens_per_call
        self.call_history: list[dict[str, Any]] = []

    def complete(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 2048,
        response_json_schema: Optional[dict[str, Any]] = None,
    ) -> LLMResponse:
        self.call_history.append({"prompt": prompt, "system": system})
        if response_json_schema is not None:
            self.requested_json_schema = response_json_schema

        # Calculate mock token usage: approx 1 token per 4 chars for prompt, fixed or ratio for output
        prompt_toks = max(1, len(prompt) // 4)
        if self.response_factory:
            content = self.response_factory(prompt, system)
        else:
            content = self.canned_response
        completion_toks = max(1, len(content) // 4)

        # Enforce budget guard
        self.budget.consume(prompt_toks, completion_toks)

        return LLMResponse(
            content=content,
            prompt_tokens=prompt_toks,
            completion_tokens=completion_toks,
            total_tokens=prompt_toks + completion_toks,
            model="mock-model",
            status_code=200,
            usage_reported=True,
            finish_reason="stop",
            raw_response={"mock": True},
        )


# ---------------------------------------------------------------------------
# OpenAI-Compatible Provider (HTTP REST)
# ---------------------------------------------------------------------------

class OpenAICompatibleProvider(BaseLLMProvider):
    """Calls any OpenAI-compatible API (OpenAI, Ollama, vLLM, OpenRouter, Groq)."""

    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str = "https://api.openai.com/v1",
        budget: Optional[TokenBudget] = None,
        timeout_s: Optional[int] = None,
        max_retries: int = MAX_ATTEMPTS,
        max_output_tokens: Optional[int] = None,
        reasoning_effort: Optional[str] = None,
        response_json_schema: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(budget=budget, timeout_s=timeout_s, max_retries=max_retries)
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        #: Ceiling for one reply, and the cap the empty-reply retry doubles up to.
        self.max_output_tokens = max_output_tokens or settings.llm_max_output_tokens
        #: Only sent to providers documented to understand it. See reasoning_payload.
        self.reasoning_effort = reasoning_effort
        #: Requested as a strict JSON schema. Endpoints that do not understand it
        #: answer 400, and the call is retried in plain json_object mode once.
        self.response_json_schema = response_json_schema
        #: Set to False after a 400 so the strict form is not tried again.
        self._strict_response_format_available = response_json_schema is not None

    def _response_format_payload(self) -> dict[str, Any]:
        if self._strict_response_format_available and self.response_json_schema:
            name = re.sub(r"[^A-Za-z0-9_-]", "_", self.model)[:64] or "extraction"
            return {
                "type": RESPONSE_FORMAT_JSON_SCHEMA,
                "json_schema": {
                    "name": name,
                    "strict": True,
                    "schema": self.response_json_schema,
                },
            }
        return {"type": RESPONSE_FORMAT_JSON_OBJECT}

    def reasoning_payload(self) -> dict[str, Any]:
        """The request body fragment that keeps reasoning small, if configured.

        OpenRouter documents a unified `reasoning` object accepting `effort`
        (max|xhigh|high|medium|low|minimal|none), `max_tokens`, `exclude` and
        `enabled`; `include_reasoning` is a deprecated alias and is not used.
        `exclude: true` keeps the reasoning text out of the response while the
        tokens are still billed, which is what we want: the caller reads the
        visible answer, not the chain of thought.

        Other OpenAI-compatible endpoints are not documented to accept this key,
        so the fragment is omitted entirely for them rather than sent and ignored.
        """
        if not self.reasoning_effort:
            return {}
        return {"reasoning": {"effort": self.reasoning_effort, "exclude": True}}

    def complete(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: Optional[int] = None,
        response_json_schema: Optional[dict[str, Any]] = None,
    ) -> LLMResponse:
        """Complete, retrying an empty reply at most once.

        A 200 with no text is not a transient outage, so it must not enter the
        backoff schedule: seven attempts against a model that is answering
        successfully but saying nothing costs minutes and changes nothing. One
        retry with a larger output budget handles the documented case where
        reasoning consumed the limit; anything else is reported immediately.
        """
        limit = max_tokens if max_tokens is not None else self.max_output_tokens
        try:
            return self._complete_once(prompt, system, temperature, limit, response_json_schema)
        except LLMEmptyReplyError as first:
            if first.finish_reason != "length":
                # Some other reason produced no text; a second identical call is
                # the only thing worth trying, and then the failure is reported.
                logger.info("Retrying once after an empty reply with finish_reason=%s",
                            first.finish_reason or "unknown")
                try:
                    return self._complete_once(prompt, system, temperature, limit, response_json_schema)
                except LLMEmptyReplyError as second:
                    raise LLMEmptyReplyError(
                        second.finish_reason,
                        prompt_tokens=second.prompt_tokens,
                        completion_tokens=second.completion_tokens,
                        reasoning_present=second.reasoning_present,
                        reasoning_tokens=second.reasoning_tokens,
                        retried=True,
                    ) from first

            # finish_reason="length": the model spent the whole budget thinking.
            # Give it a larger allowance once, up to the configured ceiling.
            if limit >= self.max_output_tokens:
                raise LLMEmptyReplyError(
                    first.finish_reason,
                    prompt_tokens=first.prompt_tokens,
                    completion_tokens=first.completion_tokens,
                    reasoning_present=first.reasoning_present,
                    reasoning_tokens=first.reasoning_tokens,
                    retried=False,
                ) from first

            raised = min(limit * 2, self.max_output_tokens)
            logger.info(
                "Empty reply with finish_reason=length; retrying once with "
                "max_tokens %d -> %d", limit, raised,
            )
            try:
                return self._complete_once(prompt, system, temperature, raised, response_json_schema)
            except LLMEmptyReplyError as second:
                raise LLMEmptyReplyError(
                    second.finish_reason,
                    prompt_tokens=second.prompt_tokens,
                    completion_tokens=second.completion_tokens,
                    reasoning_present=second.reasoning_present,
                    reasoning_tokens=second.reasoning_tokens,
                    retried=True,
                ) from first

    def _complete_once(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: Optional[int] = None,
        response_json_schema: Optional[dict[str, Any]] = None,
    ) -> LLMResponse:
        # Check budget before dispatching call
        if not self.budget.can_afford():
            raise TokenBudgetExhaustedError(
                limit=self.budget.max_tokens,
                used=self.budget.total_tokens,
            )

        messages: list[dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        # A per-call schema takes precedence over one fixed at construction.
        previous_schema = self.response_json_schema
        if response_json_schema is not None:
            self.response_json_schema = response_json_schema
            self._strict_response_format_available = True
        try:
            payload = {
                "model": self.model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "response_format": self._response_format_payload(),
            }
        finally:
            if response_json_schema is not None:
                # Keep whether the endpoint accepted it, but not the schema itself:
                # the next call may ask for a different one.
                self.response_json_schema = previous_schema
        payload.update(self.reasoning_payload())
        # Read the mode out of the payload that was actually sent. Reading it back
        # from the attributes would report whatever survived the restore above, which
        # is how a run once logged json_object while sending a strict JSON schema.
        response_format_mode = payload["response_format"]["type"]

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        url = f"{self.base_url}/chat/completions"
        last_error: Optional[Exception] = None
        last_status: Optional[int] = None

        for attempt in range(self.max_retries):
            try:
                with httpx.Client(timeout=float(self.timeout_s)) as client:
                    resp = client.post(url, json=payload, headers=headers)

                last_status = resp.status_code
                if resp.status_code in RETRYABLE_STATUSES:
                    # Remember why, so a retry loop that never succeeds can still say
                    # what the service actually answered.
                    last_error = LLMProviderError(
                        f"HTTP {resp.status_code}: {_safe_error_body(resp)}"
                    )
                    # The last attempt has nothing left to wait for.
                    if attempt < self.max_retries - 1:
                        scheduled = (
                            RETRY_BACKOFF_SECONDS[attempt]
                            if attempt < len(RETRY_BACKOFF_SECONDS)
                            else RETRY_BACKOFF_SECONDS[-1]
                        )
                        wait_time = _retry_after_seconds(resp)
                        source = "Retry-After"
                        if wait_time is None:
                            wait_time = float(scheduled)
                            source = "schedule"
                        logger.info(
                            "LLM attempt %d/%d got HTTP %d; retrying in %ss (%s)",
                            attempt + 1, self.max_retries, resp.status_code, wait_time, source,
                        )
                        time.sleep(wait_time)
                    continue

                if resp.status_code in NON_RETRYABLE_STATUSES:
                    if (
                        resp.status_code == 400
                        and self._strict_response_format_available
                        and payload["response_format"]["type"] == RESPONSE_FORMAT_JSON_SCHEMA
                    ):
                        # This endpoint does not understand a strict JSON schema.
                        # Drop it for the rest of the process and try once in the
                        # plain form rather than failing the whole run.
                        self._strict_response_format_available = False
                        payload["response_format"] = self._response_format_payload()
                        response_format_mode = payload["response_format"]["type"]
                        logger.info(
                            "Endpoint rejected response_format=%s with HTTP 400; "
                            "falling back to %s for this and later calls",
                            RESPONSE_FORMAT_JSON_SCHEMA, RESPONSE_FORMAT_JSON_OBJECT,
                        )
                        continue
                    logger.info(
                        "LLM attempt %d/%d got HTTP %d; not retrying",
                        attempt + 1, self.max_retries, resp.status_code,
                    )
                    raise LLMNonRetryableError(
                        f"HTTP {resp.status_code}: {_safe_error_body(resp)}",
                        status_code=resp.status_code,
                    )

                if resp.status_code >= 400:
                    raise LLMNonRetryableError(
                        f"HTTP {resp.status_code}: {_safe_error_body(resp)}",
                        status_code=resp.status_code,
                    )

                logger.info(
                    "LLM attempt %d/%d got HTTP %d", attempt + 1, self.max_retries, resp.status_code
                )
                resp.raise_for_status()
                data = resp.json()

                choices = data.get("choices", [])
                if not choices:
                    raise LLMProviderError("Empty choices received from OpenAI API")

                choice = choices[0]
                message = choice.get("message") or {}
                finish_reason = choice.get("finish_reason") or ""
                # content is null, not "", when a model spends the whole output
                # budget reasoning. Anything non-string is unusable as text.
                raw_content = message.get("content")
                content = raw_content if isinstance(raw_content, str) else ""
                # OpenRouter documents `reasoning`; `reasoning_content` is a
                # documented alias. Only the presence matters here, never the text.
                reasoning_present = bool(
                    message.get("reasoning") or message.get("reasoning_content")
                )

                usage = data.get("usage")
                usage_reported = isinstance(usage, dict)
                if usage_reported:
                    prompt_toks = int(usage.get("prompt_tokens", len(prompt) // 4))
                    comp_toks = int(usage.get("completion_tokens", 0))
                else:
                    # The server gave no usage; keep an estimate for budget tracking only.
                    prompt_toks = max(1, len(prompt) // 4)
                    comp_toks = 0

                # Reasoning tokens are billed as output tokens, so they explain a
                # completion count with no visible text behind it.
                completion_details = usage.get("completion_tokens_details") if usage_reported else None
                reasoning_tokens = (
                    int((completion_details or {}).get("reasoning_tokens", 0) or 0)
                    if isinstance(completion_details, dict)
                    else 0
                )

                if not content.strip():
                    self.budget.consume(prompt_toks, comp_toks)
                    logger.warning(
                        "LLM attempt %d/%d returned no text: finish_reason=%s "
                        "reasoning_present=%s reasoning_tokens=%d "
                        "prompt_tokens=%d completion_tokens=%d max_tokens=%d",
                        attempt + 1, self.max_retries, finish_reason or "unknown",
                        reasoning_present, reasoning_tokens,
                        prompt_toks, comp_toks, max_tokens,
                    )
                    raise LLMEmptyReplyError(
                        finish_reason,
                        prompt_tokens=prompt_toks,
                        completion_tokens=comp_toks,
                        reasoning_present=reasoning_present,
                        reasoning_tokens=reasoning_tokens,
                        retried=False,
                    )

                logger.info(
                    "LLM attempt %d/%d got HTTP %d finish_reason=%s completion_tokens=%d",
                    attempt + 1, self.max_retries, resp.status_code,
                    finish_reason or "unknown", comp_toks,
                )

                # Track budget
                self.budget.consume(prompt_toks, comp_toks)

                return LLMResponse(
                    content=content,
                    prompt_tokens=prompt_toks,
                    completion_tokens=comp_toks,
                    total_tokens=prompt_toks + comp_toks,
                    model=self.model,
                    status_code=resp.status_code,
                    usage_reported=usage_reported,
                    finish_reason=finish_reason,
                    reasoning_present=reasoning_present,
                    response_format_mode=response_format_mode,
                    raw_response=data,
                )
            except LLMNonRetryableError:
                # A status that must not be retried: leave the loop immediately.
                raise
            except LLMEmptyReplyError:
                # Handled by complete(), which decides whether one more attempt
                # with a bigger budget is worth making.
                raise
            except httpx.TimeoutException as exc:
                last_error = LLMTimeoutError(f"OpenAI call timed out after {self.timeout_s}s: {exc}")
            except Exception as exc:
                last_error = exc

        status_note = f" (last HTTP status {last_status})" if last_status else ""
        raise LLMProviderError(
            f"LLM request failed after {self.max_retries} attempts{status_note}: "
            f"{_redact(last_error)}"
        )


# ---------------------------------------------------------------------------
#: Default endpoint per provider. An explicit LLM_BASE_URL always wins, so a key
#: is only ever sent to the host an operator configured. Google exposes an
#: OpenAI-compatible surface for Gemini, which is why it uses this client.
PROVIDER_BASE_URLS: Final[dict[str, str]] = {
    "openai": "https://api.openai.com/v1",
    "ollama": "http://localhost:11434/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "vllm": "http://localhost:8000/v1",
    "openrouter": "https://openrouter.ai/api/v1",
}


#: Names that resolve to the offline mock. Listed in errors so the message is complete.
MOCK_PROVIDER_NAMES: Final[frozenset[str]] = frozenset({"mock", "fixture", "test"})

#: Reasoning effort per provider, and only for providers whose API documents it.
#: OpenRouter documents the unified `reasoning` object with `effort` and `exclude`;
#: the other OpenAI-compatible endpoints here are not documented to accept it, so
#: nothing is sent to them rather than sending a key the endpoint may reject.
#: `low` is chosen because these calls ask for a structured extraction, not for
#: reasoning; the budget belongs in the visible answer.
REASONING_EFFORT_BY_PROVIDER: Final[dict[str, str]] = {
    "openrouter": "low",
}


# Factory
# ---------------------------------------------------------------------------

def get_llm_provider(
    provider_name: Optional[str] = None,
    budget: Optional[TokenBudget] = None,
    mock_canned_response: Optional[str] = None,
    cfg: Optional[Settings] = None,
) -> BaseLLMProvider:
    """Factory selecting the provider implementation.

    `cfg` is the caller's Settings. It is required for anything but the mock
    provider, because reading the module-level global would make every caller
    depend on whatever the operator happens to have in their .env, and would make
    unit tests impossible to isolate.
    """
    config = cfg or settings
    name = (provider_name or config.llm_provider or "mock").strip().lower()

    if name in MOCK_PROVIDER_NAMES:
        return MockLLMProvider(canned_response=mock_canned_response, budget=budget)

    if name in PROVIDER_BASE_URLS:
        config.require_llm()
        base_url = (config.llm_base_url or "").strip() or PROVIDER_BASE_URLS[name]
        return OpenAICompatibleProvider(
            api_key=config.llm_api_key,
            model=config.llm_model,
            base_url=base_url,
            budget=budget,
            max_output_tokens=config.llm_max_output_tokens,
            reasoning_effort=REASONING_EFFORT_BY_PROVIDER.get(name),
        )

    supported = sorted(set(PROVIDER_BASE_URLS) | MOCK_PROVIDER_NAMES)
    raise ValueError(
        f"Unsupported LLM provider: {name!r}. Supported: {', '.join(supported)}"
    )
