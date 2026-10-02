#!/usr/bin/env python3
"""
attempt_1_matrix_solver_random_A.py

Solves random systems of linear equations Ax = b using three methods:
  1. Gaussian Elimination with Partial Pivoting (pure Python)
  2. LU Decomposition (Doolittle's algorithm, pure Python)
  3. NumPy LAPACK-backed solver (reference, if available)

Each method is used to solve a randomly generated system, and the results
are cross-checked against each other and against a known solution for accuracy.

Run: python attempt_1_matrix_solver_random_A.py [--size N] [--seed S] [--numpy-only]

Requirements: None for methods 1 & 2; numpy (optional) for method 3.
"""

from __future__ import annotations

import argparse
import copy
import math
import random
import sys
import time
from typing import List, Tuple, Optional, Callable


# ── Utility types ────────────────────────────────────────────────────────

Matrix = List[List[float]]
Vector = List[float]


# ── 1. Gaussian Elimination with Partial Pivoting ────────────────────────

def _copy_matrix(A: Matrix) -> Matrix:
    return [row[:] for row in A]


def _copy_vector(b: Vector) -> Vector:
    return b[:]


def gauss_elimination(A: Matrix, b: Vector) -> Tuple[Vector, float]:
    """Solve Ax = b via Gaussian elimination with partial pivoting.

    Returns (x, condition_estimate), where condition_estimate is the ratio
    of the largest to smallest pivot magnitudes encountered.  Values > 1e10
    suggest a nearly singular system.

    Does **not** mutate A or b (works on copies).
    """
    n = len(A)
    assert all(len(row) == n for row in A), "A must be square"
    assert len(b) == n, "b length must match A rows"

    M = _copy_matrix(A)
    F = _copy_vector(b)  # augmented vector [F | ...] — not actually augmented

    condition_est = 0.0
    max_pivot_mag = 0.0
    min_pivot_mag = float("inf")

    for col in range(n):
        # ── Partial pivot: find the row with the largest |M[row][col]| below col ──
        pivot_row = col
        max_val = abs(M[col][col])
        for row in range(col + 1, n):
            if abs(M[row][col]) > max_val:
                max_val = abs(M[row][col])
                pivot_row = row

        if max_val < 1e-14:
            continue  # skip zero columns; condition_est will blow up later

        condition_est = max(condition_est, abs(M[col][col]) / max(1e-14, min_pivot_mag)) if col > 0 else 1.0

        # Swap rows in M and F
        if pivot_row != col:
            M[col], M[pivot_row] = M[pivot_row], M[col]
            F[col], F[pivot_row] = F[pivot_row], F[col]

        tracked_max = max(abs(M[r][r]) for r in range(n) if abs(M[r][r]) > 1e-14)
        if col == 0 or abs(M[col][col]) > tracked_max:
            condition_est = 0.0
        min_pivot_mag = min(min_pivot_mag, abs(M[col][col]))

    # ── Forward elimination ──
    for col in range(n):
        piv = M[col][col]
        if abs(piv) < 1e-14:
            continue
        for row in range(col + 1, n):
            factor = M[row][col] / piv
            F[row] -= factor * F[col]
            for j in range(col, n):
                M[row][j] -= factor * M[col][j]

    # ── Back substitution ──
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        if abs(M[i][i]) < 1e-14:
            raise LinAlgError(f"Singular (or nearly singular) matrix at pivot {i}")
        s = F[i]
        for j in range(i + 1, n):
            s -= M[i][j] * x[j]
        x[i] = s / M[i][i]

    # Estimate condition number heuristic
    est = min_pivot_mag if min_pivot_mag == float("inf") else tracked_max / max(min_pivot_mag, 1e-14)
    return x, est


# ── 2. LU Decomposition (Doolittle) ─────────────────────────────────────

class LinAlgError(Exception):
    pass


def lu_decomposition(A: Matrix) -> Tuple[Matrix, Matrix]:
    """Decompose A into L and U where A = LU, using Doolittle's algorithm.

    L is unit lower-triangular; U is upper-triangular.  Neither is mutated.
    Returns (L, U).
    """
    n = len(A)
    L = [[0.0] * n for _ in range(n)]
    U = [[0.0] * n for _ in range(n)]
    for i in range(n):
        L[i][i] = 1.0

    for j in range(n):
        # Compute U[row][j] for rows 0..j
        for i in range(j + 1):
            s = 0.0
            for k in range(i):
                s += L[i][k] * U[k][j]
            U[i][j] = A[i][j] - s

        # Compute L[j][col] for rows j+1..n-1
        for i in range(j + 1, n):
            s = 0.0
            for k in range(j):
                s += L[i][k] * U[k][j]
            u_val = A[i][j] - s
            if abs(U[j][j]) < 1e-14:
                raise LinAlgError(
                    f"LU breakdown at ({j},{j}): pivot = {U[j][j]}. "
                    "Matrix may be singular."
                )
            L[i][j] = u_val / U[j][j]

    return L, U


def solve_lu(A: Matrix, b: Vector) -> Tuple[Vector, float]:
    """Solve Ax = b via LU decomposition + forward/back substitution."""
    L, U = lu_decomposition(A)
    n = len(b)

    # Forward substitution: Ly = b  (L is unit lower-triangular)
    y = [0.0] * n
    for i in range(n):
        s = 0.0
        for k in range(i):
            s += L[i][k] * y[k]
        y[i] = b[i] - s

    # Back substitution: Ux = y  (U is upper-triangular)
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        if abs(U[i][i]) < 1e-14:
            raise LinAlgError(f"Singular matrix at LU pivot {i}")
        s = y[i]
        for k in range(i + 1, n):
            s -= U[i][k] * x[k]
        x[i] = s / U[i][i]

    return x, float("inf")  # condition not estimated here


# ── 3. NumPy solver (optional) ──────────────────────────────────────────

def solve_numpy(A: Matrix, b: Vector) -> Tuple[Vector, Optional[float]]:
    """Solve Ax = b via NumPy (LAPACK-backed). Returns x and condition number."""
    import numpy as np  # noqa: F811
    n = len(b)
    A_np = np.array(A, dtype=np.float64)
    b_np = np.array(b, dtype=np.float64)
    x_np = np.linalg.solve(A_np, b_np)
    cond = float(np.linalg.cond(A_np))
    return [float(v) for v in x_np], cond


# ── System generation utilities ───────────────────────────────────────────

def rand_matrix(n: int, rng: random.Random) -> Matrix:
    """Generate a random n×n matrix with entries in [-5, 5]."""
    return [[rng.uniform(-5, 5) for _ in range(n)] for _ in range(n)]


def diagonal_dominate(A: Matrix, rng: random.Random) -> Matrix:
    """Make A diagonally dominant to ensure non-singularity."""
    n = len(A)
    A_copy = copy.deepcopy(A)
    for i in range(n):
        row_sum = sum(abs(A_copy[i][j]) for j in range(n) if j != i)
        A_copy[i][i] = row_sum + rng.uniform(1, 5)
    return A_copy


def rand_vector(n: int, rng: random.Random) -> Vector:
    """Generate a random vector with entries in [-5, 5]."""
    return [rng.uniform(-5, 5) for _ in range(n)]


# ── Output helpers ───────────────────────────────────────────────────────

def vec_str(x: Vector, width: int = 12) -> str:
    return " | ".join(f"{v:{width}.6f}" for v in x)


def mat_str(A: Matrix, width: int = 8) -> str:
    lines = []
    for row in A:
        lines.append(" | ".join(f"{v:{width}.4f}" for v in row))
    return "\n".join(lines)


# ── Verification helpers ─────────────────────────────────────────────────

def residual(A: Matrix, x: Vector, b: Vector) -> float:
    """Compute the ∞-norm of Ax - b."""
    n = len(b)
    err = 0.0
    for i in range(n):
        s = sum(A[i][j] * x[j] for j in range(n)) - b[i]
        err = max(err, abs(s))
    return err


# ── Main solver runner ───────────────────────────────────────────────────

SOLVERS: list[tuple[str, Callable[[Matrix, Vector], tuple[Vector, float]]]] = [
    ("Gaussian Elimination (partial pivot)", gauss_elimination),
    ("LU Decomposition (Doolittle)", solve_lu),
]


def run_solver(
    name: str,
    solver_fn: Callable[[Matrix, Vector], tuple[Vector, float]],
    A: Matrix,
    b: Vector,
    x_true: Optional[Vector],
) -> dict:
    t0 = time.perf_counter()
    try:
        x, extra = solver_fn(A, b)
        elapsed = time.perf_counter() - t0
        res = residual(A, x, b)
        info = f"cond-est={extra:.2e}" if not math.isinf(extra) else ""
        err_to_true = None
        if x_true is not None:
            err_to_true = max(abs(x[i] - x_true[i]) for i in range(len(x)))
        return {"name": name, "elapsed_ms": elapsed * 1e3, "residual": res, "info": info, "x": x, "err_to_true": err_to_true}
    except Exception as exc:
        elapsed = time.perf_counter() - t0
        return {"name": name, "elapsed_ms": elapsed * 1e3, "residual": None, "info": str(exc), "x": None, "err_to_true": None}


def print_header(title: str) -> None:
    sep = "=" * max(len(title) + 4, 60)
    print(f"\n{sep}")
    print(f"  {title}")
    print(sep)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Matrix solver benchmark for random Ax=b systems."
    )
    parser.add_argument("--size", "-n", type=int, default=50, help="Matrix dimension (default: 50)")
    parser.add_argument("--seed", "-s", type=int, default=42, help="Random seed (default: 42)")
    parser.add_argument("--runs", "-r", type=int, default=3, help="Number of random systems to solve (default: 3)")
    parser.add_argument("--numpy-only", action="store_true", help="Use only the NumPy solver")
    args = parser.parse_args()

    n = args.size
    rng = random.Random(args.seed)

    # Build system: A is diagonally dominant → guaranteed non-singular
    print_header(f"Attempt 1 — Matrix Solver ({n}×{n} systems)")
    print(f"  Seed      : {args.seed}")
    print(f"  Systems   : {args.runs}")

    if not args.numpy_only:
        solver_list = SOLVERS
    else:
        try:
            import numpy  # noqa: F811
            print_header("NumPy Solver Only (mode)")
            solver_list = [("NumPy / LAPACK", solve_numpy)]
        except ImportError:
            print("\nERROR: NumPy is required for --numpy-only mode.")
            print("Install it with: pip install numpy")
            sys.exit(1)

    # ── Run experiments ────────────────────────────────────────────────
    for run in range(1, args.runs + 1):
        print_header(f"Run {run} — Random System #{run}")

        A = diagonal_dominate(rand_matrix(n, rng), rng)
        x_true = rand_vector(n, rng)
        b = [sum(A[i][j] * x_true[j] for j in range(n)) for i in range(n)]

        print(f"\n  Matrix (first 5×5 block):")
        print("    " + "\n    ".join(mat_str(A)[:300].split("\n")))
        if n > 5:
            print(f"    ... [{n}×{n} full matrix]")

        print(f"\n  True solution x = b (first 10 entries):")
        print("    " + vec_str(x_true[:10], width=12))
        if n > 10:
            print(f"    ... [{n} total entries]")

        print(f"\n{'Method':<45s} {'Time (ms)':>10s} {'Residual':>14s}  {'Info'}")
        print("-" * 90)

          results: list[dict] = []
          for sname, sfn in solver_list:
              result = run_solver(sname, sfn, A, b, x_true)
              results.append(result)

        for res in results:
            elapsed = res["elapsed_ms"]
            residual_val = res["residual"]
            info = res["info"]
            err_t = res["err_to_true"]

            part = f"  ✓ {res['name']:<40s}" if residual_val is not None and residual_val < 1e-8 else (
                f"  ✗ {res['name']:<40s}" if residual_val is not None else
                f"  ⚠ {res['name']:<40s}"
            )
            print(f"{part}  {elapsed:>10.3f}  "
                  f"{residual_val if residual_val is not None else float('inf'):>14.2e}  "
                  f"{'err_to_true=' + f'{err_t:.2e}' if err_t is not None else ''}"
                  f"{' | ' + info if info and residual_val is None else ''}")

    # ── Summary ────────────────────────────────────────────────────────
    print_header("SUMMARY")
    print(f"""
  This script demonstrates three matrix solving approaches:

  1. Gaussian Elimination with Partial Pivoting
     - O(n³) complexity, pivoting prevents divide-by-zero & reduces error growth
     - Numerically stable for well-conditioned matrices (cond < ~1e12)

  2. LU Decomposition (Doolittle's algorithm)
     - Factor once: A = LU; then solve Ly=b and Ux=y via substitution
     - Reuse L,U for multiple right-hand sides — ideal for systems with same A, different b

  3. NumPy / LAPACK (optional)
     - Gold-standard reference using highly-optimized BLAS/LAPACK routines
     - Condition number provided as system quality indicator

  Diagonally-dominant random matrices ensure non-singularity across all runs.
  Residuals near machine epsilon (~1e-14 for float64) indicate correct implementation.
""")

    # ── Optional: demo with a tiny 3×3 system ──────────────────────────
    print_header("Mini Demo — 3×3 System (hard-coded)")
    A_demo: Matrix = [
        [2, 1, -1],
        [-3, -1, 2],
        [-2, 1, 2],
    ]
    b_demo: Vector = [8, -11, -3]
    # Expected: x = [2, 3, -1]

    print("\n  A (demo system):")
    print("    " + "\n    ".join(mat_str(A_demo)))
    print(f"\n  b = {vec_str(b_demo)}")
    print(f"  Known solution: x = [ 2.000000,  3.000000, -1.000000]")

    for sname, sfn in solver_list:
        try:
            x_sol, extra = sfn(A_demo, b_demo)
            print(f"\n  → {sname}")
            print(f"      Solution : {vec_str(x_sol)}")
            print(f"      Residual : {residual(A_demo, x_sol, b_demo):.2e}")
        except LinAlgError as exc:
            print(f"\n  → {sname}: ERROR — {exc}")


if __name__ == "__main__":
    main()
