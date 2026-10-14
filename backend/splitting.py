"""Pure NumPy stratified data splitting and cross-validation index generator.

Provides:
  - train_test_split_scratch: Seeded stratified train/test partitioning with
    exact complement rounding (n_test = ceil(N * test_size)), class preservation,
    and row index tracking.
  - StratifiedKFoldScratch: Seeded stratified K-fold cross-validation index generator.
"""

from __future__ import annotations

import math
from typing import Iterator

import numpy as np


def train_test_split_scratch(
    y: np.ndarray,
    test_size: float = 0.3,
    random_state: int = 42,
) -> tuple[np.ndarray, np.ndarray, dict]:
    """Perform seeded stratified train/test split.

    Args:
        y: 1D array of binary outcome labels (0 or 1).
        test_size: Fraction of samples for the test set, in [0.05, 0.80].
        random_state: Integer seed for reproducibility.

    Returns:
        train_indices: 1D array of original row indices allocated to training.
        test_indices: 1D array of original row indices allocated to testing.
        split_meta: Dictionary with requested and actual percentages and counts.
    """
    y = np.asarray(y, dtype=int)
    N = len(y)

    if not 0.05 <= test_size <= 0.80:
        raise ValueError(
            f"Test split must be between 5% and 80% (0.05 to 0.80), got {test_size:.2%}"
        )

    # Class counts
    idx_0 = np.where(y == 0)[0]
    idx_1 = np.where(y == 1)[0]
    N_0 = len(idx_0)
    N_1 = len(idx_1)

    if N_0 == 0 or N_1 == 0:
        raise ValueError("Cannot perform stratified split with only one outcome class.")
    if N_0 < 2 or N_1 < 2:
        raise ValueError(
            f"Stratified split requires at least 2 observations in each outcome class. "
            f"Observed counts: class 0 has {N_0}, class 1 has {N_1}."
        )

    # Exact complement rounding
    n_test = math.ceil(N * test_size)
    n_train = N - n_test

    if n_test < 2 or n_train < 2:
        raise ValueError(
            f"The requested test split leaves too few rows (train: {n_train}, test: {n_test}). "
            "Use more data or adjust the split percentage."
        )

    # Deterministic Hamilton-Hare (largest remainder) allocation per class
    # Ideal proportional test count
    q_0 = n_test * (N_0 / N)
    q_1 = n_test * (N_1 / N)

    floor_0 = int(math.floor(q_0))
    floor_1 = int(math.floor(q_1))
    remainder_0 = q_0 - floor_0
    remainder_1 = q_1 - floor_1

    needed = n_test - (floor_0 + floor_1)
    if needed == 1:
        if remainder_0 >= remainder_1:
            floor_0 += 1
        else:
            floor_1 += 1
    elif needed == 2:
        floor_0 += 1
        floor_1 += 1

    n_test_0 = floor_0
    n_test_1 = floor_1

    # Guarantee at least 1 sample from each class in both train and test partitions
    if n_test_0 < 1:
        n_test_0 = 1
        n_test_1 = n_test - 1
    elif n_test_0 >= N_0:
        n_test_0 = N_0 - 1
        n_test_1 = n_test - n_test_0

    if n_test_1 < 1:
        n_test_1 = 1
        n_test_0 = n_test - 1
    elif n_test_1 >= N_1:
        n_test_1 = N_1 - 1
        n_test_0 = n_test - n_test_1

    # Verify both partitions have >= 1 of each class
    if not (1 <= n_test_0 <= N_0 - 1) or not (1 <= n_test_1 <= N_1 - 1):
        raise ValueError(
            "The requested split cannot guarantee both classes in both train and test sets. "
            f"Counts: class 0 has {N_0}, class 1 has {N_1}."
        )

    # Seeded shuffling of indices within each class
    rng = np.random.default_rng(random_state)
    shuffled_idx_0 = rng.permutation(idx_0)
    shuffled_idx_1 = rng.permutation(idx_1)

    test_0 = shuffled_idx_0[:n_test_0]
    train_0 = shuffled_idx_0[n_test_0:]

    test_1 = shuffled_idx_1[:n_test_1]
    train_1 = shuffled_idx_1[n_test_1:]

    test_indices = np.sort(np.concatenate([test_0, test_1]))
    train_indices = np.sort(np.concatenate([train_0, train_1]))

    # Verify disjointness and complete coverage
    assert len(set(test_indices).intersection(set(train_indices))) == 0
    assert len(test_indices) + len(train_indices) == N

    split_meta = {
        "requested_test_percent": round(test_size * 100.0, 1),
        "actual_test_percent": round((n_test / N) * 100.0, 2),
        "requested_train_percent": round((1.0 - test_size) * 100.0, 1),
        "actual_train_percent": round((n_train / N) * 100.0, 2),
        "n_train": int(n_train),
        "n_test": int(n_test),
        "rounding_rule": "n_test = ceil(N * test_size); n_train = N - n_test",
    }

    return train_indices, test_indices, split_meta


class StratifiedKFoldScratch:
    """Stratified K-Fold cross-validation index splitter from scratch."""

    def __init__(self, n_splits: int = 5, shuffle: bool = True, random_state: int = 42):
        if n_splits < 2:
            raise ValueError(f"n_splits must be at least 2, got {n_splits}")
        self.n_splits = int(n_splits)
        self.shuffle = bool(shuffle)
        self.random_state = int(random_state)

    def split(self, X: np.ndarray, y: np.ndarray) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        y = np.asarray(y, dtype=int)
        N = len(y)

        idx_0 = np.where(y == 0)[0]
        idx_1 = np.where(y == 1)[0]

        if len(idx_0) < self.n_splits or len(idx_1) < self.n_splits:
            raise ValueError(
                f"Cannot create {self.n_splits} stratified folds: class 0 has {len(idx_0)} "
                f"and class 1 has {len(idx_1)} observations (need at least {self.n_splits} each)."
            )

        rng = np.random.default_rng(self.random_state) if self.shuffle else None

        if rng is not None:
            idx_0 = rng.permutation(idx_0)
            idx_1 = rng.permutation(idx_1)

        # Split class 0 and class 1 into n_splits chunks
        folds_0 = np.array_split(idx_0, self.n_splits)
        folds_1 = np.array_split(idx_1, self.n_splits)

        for fold_idx in range(self.n_splits):
            val_idx = np.sort(np.concatenate([folds_0[fold_idx], folds_1[fold_idx]]))
            train_mask = np.ones(N, dtype=bool)
            train_mask[val_idx] = False
            train_idx = np.where(train_mask)[0]
            yield train_idx, val_idx
