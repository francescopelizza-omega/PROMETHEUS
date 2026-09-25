#!/usr/bin/env python3
"""
vafammok.py — Quadratic Equation Solver (ax² + bx + c = 0)

Solves for x with full step-by-step calculation and displays:
  • discriminant analysis
  • roots (real or complex)
  • vertex of the parabola
  • axis of symmetry
"""

import math
import cmath


def solve_quadratic(a: float, b: float, c: float) -> dict:
    """Return a full solution dict for ax² + bx + c = 0."""

    if a == 0:
        # Degenerates to linear: bx + c = 0
        if b == 0:
            return {"error": "Not an equation (a=b=0)"}
        return {
            "degree": 1,
            "discriminant": None,
            "roots": [-c / b],
            "root_type": "single real",
            "vertex": None,
            "axis_of_symmetry": None,
            "steps": [
                f"Degenerate case: a = 0 → linear equation {b}x + {c} = 0",
                f"x = -c / b = {-c} / {b} = {-c / b}",
            ],
        }

    # --- Quadratic case ---
    steps: list[str] = []

    # Step 1: discriminant
    delta = b * b - 4 * a * c
    steps.append(f"Step 1 — discriminant Δ = b² − 4ac")
    steps.append(f"        Δ = ({b})² − 4 · ({a}) · ({c})")
    steps.append(f"        Δ = {b*b} − {4*a*c} = {delta}")

    # Step 2: roots
    if delta > 0:
        sqrt_delta = math.sqrt(delta)
        x1 = (-b + sqrt_delta) / (2 * a)
        x2 = (-b - sqrt_delta) / (2 * a)
        root_type_str = "two distinct real"
        steps.extend([
            f"\nStep 2 — Δ > 0 → two distinct REAL roots",
            f"        √Δ = {sqrt_delta:.6f}",
            f"        x₁ = (-b + √Δ) / (2a)",
            f"             = ({-b} + {sqrt_delta:.6f}) / {2*a}",
            f"             = {x1:.6f}",
            f"        x₂ = (-b - √Δ) / (2a)",
            f"             = ({-b} - {sqrt_delta:.6f}) / {2*a}",
            f"             = {x2:.6f}",
        ])
    elif delta == 0:
        x1 = x2 = -b / (2 * a)
        root_type_str = "one repeated real (double root)"
        steps.extend([
            f"\nStep 2 — Δ = 0 → one repeated REAL root",
            f"        x = -b / (2a) = {-b} / {2*a} = {x1:.6f}",
        ])
    else:
        sqrt_delta_cmplx = cmath.sqrt(delta)
        real_part = -b / (2 * a)
        imag_part = sqrt_delta_cmplx.imag / abs(2 * a) if 2 * a != 0 else 0
        x1 = complex(real_part, math.fabs(sqrt_delta_cmplx.imag) / (2 * abs(a)))
        x2 = complex(real_part, -math.fabs(sqrt_delta_cmplx.imag) / (2 * abs(a)))
        root_type_str = "two complex conjugate"
        steps.extend([
            f"\nStep 2 — Δ < 0 → two COMPLEX conjugate roots",
            f"        x₁ = {x1.real:.6f} + {abs(x1.imag):.6f}i",
            f"        x₂ = {x2.real:.6f} - {abs(x2.imag):.6f}i",
        ])

    # --- Vertex & axis of symmetry ---
    h = -b / (2 * a)
    k = a * h * h + b * h + c
    vertex = (h, k)
    axis = h

    info = {
        "a": a, "b": b, "c": c,
        "discriminant": delta,
        "roots": [x1, x2],
        "root_type": root_type_str,
        "vertex": vertex,
        "axis_of_symmetry": axis,
        "steps": steps,
    }
    return info


def print_solution(sol: dict) -> None:
    """Pretty-print a solution dict."""

    eq = sol["a"]
    sign_b = "+" if sol["b"] >= 0 else ""
    sign_c = "+" if sol["c"] >= 0 else ""
    print(f"\n{'='*56}")
    print(f"   Solving: {eq}x² + {sign_b}{sol['b']}x + {sign_c}{sol['c']} = 0")
    print(f"{'='*56}\n")

    if "error" in sol:
        print(sol["error"])
        return

    for step in sol["steps"]:
        print(step)

    print(f"\n{'─'*56}")
    print(f"  Vertex:       ({sol['vertex'][0]:.6f}, {sol['vertex'][1]:.6f})")
    print(f"  Axis of sym:  x = {sol['axis_of_symmetry']:.6f}")
    print(f"{'='*56}\n")


# ---------------------------------------------------------------
def main():
    while True:
        print("┌─────────────────────────────────────────────┐")
        print("│   Quadratic Equation Solver  ax² + bx + c    │")
        print("│                                             │")
        print("│  Type 'quit' or 'q' to exit                 │")
        print("│  Type 'demo' for examples                    │")
        print("└─────────────────────────────────────────────┘\n")

        raw = input("Enter a, b, c (space-separated), or q: ").strip()
        if raw.lower() in ("q", "quit"):
            print("\nGoodbye.\n")
            return
        if raw.lower() == "demo":
            demos = [
                (1, -5, 6),    # x² − 5x + 6 = 0  →  two real: 3, 2
                (1, 4, 4),     # x² + 4x + 4 = 0  →  one real: −2
                (1, 2, 5),     # x² + 2x + 5 = 0  →  complex: −1±2i
                (0, -3, 9),    # −3x + 9 = 0      →  linear: 3
                (2, 0, -8),    # 2x² − 8 = 0      →  two real: ±2
            ]
            for a, b, c in demos:
                print_solution(solve_quadratic(a, b, c))
            continue

        try:
            parts = raw.split()
            if len(parts) != 3:
                print("  ⚠  Please enter exactly three numbers.\n")
                continue
            a, b, c = (float(s) for s in parts)
            solution = solve_quadratic(a, b, c)
            print_solution(solution)
        except ValueError:
            print("  ⚠  Invalid input. Use numbers like -3, 2.5, 0\n")


if __name__ == "__main__":
    main()
