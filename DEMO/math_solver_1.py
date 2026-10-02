#!/usr/bin/env python3
"""math_solver_1.py — Solve 10 diverse math equations."""

import math


def main():
    print("=" * 60)
    print("       MATH SOLVER — 10 Equations Solved")
    print("=" * 60)

    results: list[tuple[str, str]] = []

    # ── Equation 1: Quadratic formula  (x² − 5x + 6 = 0) ──
    a, b, c = 1, -5, 6
    disc = b**2 - 4*a*c
    x1 = (-b + math.sqrt(disc)) / (2*a)
    x2 = (-b - math.sqrt(disc)) / (2*a)
    results.append(("Quadratic: x² − 5x + 6 = 0", f"x₁ = {x1}, x₂ = {x2}"))

    # ── Equation 2: Pythagorean theorem  (a² + b² = c²) ──
    a, b = 3, 4
    c = math.sqrt(a**2 + b**2)
    results.append(("Hypotenuse: √(3² + 4²)", f"c = {c}"))

    # ── Equation 3: Logarithm  (ln(e³)) ──
    val = math.log(math.e**3)
    results.append(("Natural log: ln(e³)", f"= {val}"))

    # ── Equation 4: Exponential growth  A = P·e^(rt) ──
    P, r, t = 1000, 0.05, 10
    A = P * math.e**(r*t)
    results.append(("Compound growth: 1000·e^(0.05·10)", f"= {A:.2f}"))

    # ── Equation 5: Trigonometry  (sin(π/6)) ──
    angle = math.pi / 6
    results.append((f"Trig: sin(π/6) = sin({angle:.4f})", f"= {math.sin(angle):.10f}"))

    # ── Equation 6: Circle area  (A = πr², r = 7) ──
    r = 7
    area = math.pi * r**2
    results.append(("Circle area: π·7²", f"= {area:.4f}"))

    # ── Equation 7: Sum of first n naturals  S = n(n+1)/2, n = 100 ──
    n = 100
    s = n * (n + 1) // 2
    results.append(("Sum 1..100: 100·101/2", f"= {s}"))

    # ── Equation 8: Standard normal PDF at x = 0 ──
    x = 0
    pdf = (1 / math.sqrt(2 * math.pi)) * math.e**(-x**2 / 2)
    results.append(("Normal PDF: φ(0)", f"= {pdf:.6f}"))

    # ── Equation 9: Hypotenuse of a 5-12-? triangle ──
    a, b = 5, 12
    c = math.hypot(a, b)
    results.append((f"Hypotenuse: √(5² + 12²)", f"= {c}"))

    # ── Equation 10: Base conversion — log₂(1024) ──
    val = math.log2(1024)
    results.append(("Log base 2: log₂(1024)", f"= {val}"))

    # ── Print summary ──
    for i, (equation, solution) in enumerate(results, start=1):
        print(f"\n[{i}]  Equation:  {equation}")
        print(f"       Solved:  {solution}")

    print("\n" + "=" * 60)
    print("         All 10 equations solved successfully ✅")
    print("=" * 60)


if __name__ == "__main__":
    main()
