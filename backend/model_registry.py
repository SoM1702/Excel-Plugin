"""Bounded, process-local model storage for the invited hosted beta only.

This registry is not a durable or authenticated multi-user store. It is safe to
use across threads in one worker process; separate workers have separate state.
"""

from __future__ import annotations

from collections import OrderedDict
from threading import RLock
import time
from typing import Callable, Generic, Protocol, TypeVar


class HasModelId(Protocol):
    model_id: str


ModelT = TypeVar("ModelT", bound=HasModelId)


class ModelRegistry(Generic[ModelT]):
    def __init__(
        self,
        max_models: int = 100,
        ttl_seconds: float = 24 * 60 * 60,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_models < 1:
            raise ValueError("max_models must be at least 1")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be greater than 0")
        self.max_models = max_models
        self.ttl_seconds = ttl_seconds
        self._clock = clock
        self._models: OrderedDict[str, tuple[ModelT, float]] = OrderedDict()
        self._lock = RLock()

    def _expire_locked(self, now: float) -> None:
        expired_ids = [
            model_id
            for model_id, (_, created_at) in self._models.items()
            if now - created_at >= self.ttl_seconds
        ]
        for model_id in expired_ids:
            self._models.pop(model_id, None)

    def store(self, model: ModelT) -> None:
        model_id = getattr(model, "model_id", None)
        if not isinstance(model_id, str) or not model_id:
            raise ValueError("model must have a non-empty string model_id")
        now = self._clock()
        with self._lock:
            self._expire_locked(now)
            self._models.pop(model_id, None)
            self._models[model_id] = (model, now)
            while len(self._models) > self.max_models:
                self._models.popitem(last=False)

    def get(self, model_id: str) -> ModelT | None:
        now = self._clock()
        with self._lock:
            self._expire_locked(now)
            entry = self._models.get(model_id)
            if entry is None:
                return None
            self._models.move_to_end(model_id)
            return entry[0]

    def clear(self) -> None:
        with self._lock:
            self._models.clear()

    def __len__(self) -> int:
        with self._lock:
            self._expire_locked(self._clock())
            return len(self._models)
