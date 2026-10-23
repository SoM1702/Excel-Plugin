"""Tests for the temporary, bounded beta model registry."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import unittest

from model_registry import ModelRegistry


@dataclass
class FakeModel:
    model_id: str


class ModelRegistryTests(unittest.TestCase):
    def test_lru_evicts_least_recently_used_model(self):
        registry = ModelRegistry(max_models=2, ttl_seconds=100)
        first = FakeModel("first")
        second = FakeModel("second")
        third = FakeModel("third")
        registry.store(first)
        registry.store(second)

        self.assertIs(registry.get("first"), first)  # Make first most recently used.
        registry.store(third)

        self.assertIsNone(registry.get("second"))
        self.assertIs(registry.get("first"), first)
        self.assertIs(registry.get("third"), third)
        self.assertEqual(len(registry), 2)

    def test_expired_model_is_not_returned_or_counted(self):
        now = [10.0]
        registry = ModelRegistry(max_models=2, ttl_seconds=5, clock=lambda: now[0])
        model = FakeModel("expires")
        registry.store(model)
        now[0] += 5

        self.assertIsNone(registry.get("expires"))
        self.assertEqual(len(registry), 0)

    def test_clear_removes_all_models(self):
        registry = ModelRegistry(max_models=3, ttl_seconds=100)
        registry.store(FakeModel("one"))
        registry.store(FakeModel("two"))
        registry.clear()
        self.assertEqual(len(registry), 0)

    def test_concurrent_stores_remain_bounded_and_retrievable_when_capacity_allows(self):
        registry = ModelRegistry(max_models=100, ttl_seconds=100)
        models = [FakeModel(str(index)) for index in range(100)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(registry.store, models))

        self.assertEqual(len(registry), 100)
        for model in models:
            self.assertIs(registry.get(model.model_id), model)

    def test_invalid_configuration_and_model_are_rejected(self):
        with self.assertRaises(ValueError):
            ModelRegistry(max_models=0)
        with self.assertRaises(ValueError):
            ModelRegistry(ttl_seconds=0)
        with self.assertRaises(ValueError):
            ModelRegistry().store(object())


if __name__ == "__main__":
    unittest.main()
