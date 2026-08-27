/**
 * tui/quantum-verbs.ts — the "working…" spinner vocabulary (WRAPPER extra).
 *
 * While a turn runs, the TUI shows a live line like `⠹ Entangling… (3s · esc to interrupt)`.
 * The verb rotates through a physics-and-math lexicon (a nod to Claude Code's "Vibing…"/
 * "Smooshing…", but every word is a real or eponym-derived quantum, particle, condensed-matter,
 * optics, or mathematics term in -ing form). PURE: deterministic pickers + a caps-gated
 * formatter; the host owns the timer and per-turn seed.
 */
import { type ColorCaps, paint } from "./palette.js";

/** The rotating working verbs — quantum + particle-physics, all -ing. */
export const QUANTUM_VERBS: readonly string[] = Object.freeze([
  "Entangling",
  "Superposing",
  "Decohering",
  "Tunneling",
  "Collapsing",
  "Renormalizing",
  "Quantizing",
  "Thermalizing",
  "Perturbing",
  "Diagonalizing",
  "Interfering",
  "Teleporting",
  "Wick-rotating",
  "Gauge-fixing",
  "Bosonizing",
  "Fermionizing",
  "Hadronizing",
  "Path-integrating",
  "Tensor-contracting",
  "Spin-flipping",
  "Qubit-phasing",
  "Anyon-braiding",
  "Bell-correlating",
  "Vacuum-fluctuating",
  "Zero-point-jittering",
  "Heisenberg-nudging",
  "Schrödingering",
  "Feynman-diagramming",
  "Wave-packeting",
  "Eigenstate-solving",
  "Coherence-braiding",
  "Bogoliubov-transforming",
  "Symmetry-breaking",
  "Casimir-squeezing",
  "Neutrino-oscillating",
  "Photon-splitting",
  "Planck-scaling",
  "Observer-collapsing",
  "Uncertainty-smearing",
  "Hilbert-projecting",
  // Nuclear & particle physics.
  "Nuclear-fissioning",
  "Nuclear-fusioning",
  "Matrixing",
  "Annihilating",
  "Beta-decaying",
  "Alpha-decaying",
  "Gamma-emitting",
  "Positron-emitting",
  "Transmuting",
  "Quark-confining",
  "Gluon-exchanging",
  "Meson-exchanging",
  "Higgs-coupling",
  "Compton-scattering",
  "Rutherford-scattering",
  "Cherenkov-radiating",
  "Bremsstrahlung-radiating",
  "Cascading",
  "Ionizing",
  // Condensed matter.
  "Cooper-pairing",
  "Meissner-expelling",
  "Josephson-tunneling",
  "Flux-pinning",
  "Landau-damping",
  "Debye-screening",
  "Superconducting",
  "Superfluiding",
  "Condensing",
  "Doping",
  "Phonon-scattering",
  "Magnon-propagating",
  "Exciton-binding",
  "Plasmon-resonating",
  "Polariton-coupling",
  "Skyrmion-twisting",
  // Optics & photonics.
  "Diffracting",
  "Refracting",
  "Polarizing",
  "Fluorescing",
  "Phosphorescing",
  "Zeeman-splitting",
  "Stark-shifting",
  "Lamb-shifting",
  // Classical, thermal & misc physics.
  "Precessing",
  "Resonating",
  "Nucleating",
  "Percolating",
  "Diffusing",
  "Convecting",
  "Sublimating",
  "Crystallizing",
  "Levitating",
  "Aharonov-Bohm-phasing",
  "Quantum-annealing",
  // Mathematics & named numerical methods.
  "Simpson-diffusing",
  "Newton-Raphsoning",
  "Runge-Kutta-integrating",
  "Euler-integrating",
  "Riemann-summing",
  "Monte-Carlo-sampling",
  "Markov-chaining",
  "Bayes-updating",
  "Gradient-descending",
  "Lagrange-interpolating",
  "Fourier-transforming",
  "Laplace-transforming",
  "Taylor-expanding",
  "Jacobian-transforming",
  "Eigen-decomposing",
  "Convolving",
  "Kalman-filtering",
  "Romberg-integrating",
  "Trapezoid-ruling",
  "Bézier-curving",
  "Spline-fitting",
  "Zeta-summing",
  "Mandelbrot-iterating",
  "Lyapunov-diverging",
  "Fibonacci-recursing",
  "Poisson-processing",
  "Gaussian-blurring",
  "Stokes-theoreming",
  "Green-functioning",
  // Named-effect / multi-eponym combos.
  "Bose-Einstein-condensating",
  "Fermi-Dirac-distributing",
  "Maxwell-Boltzmann-distributing",
  "Van-der-Waals-bonding",
  "Navier-Stokes-solving",
  "Yang-Mills-coupling",
  "Klein-Gordon-solving",
  "Born-Oppenheimer-approximating",
  "Ginzburg-Landau-modeling",
  "Fokker-Planck-diffusing",
  "Euler-Lagrange-minimizing",
  "Cauchy-Riemann-satisfying",
]);

/** The braille spinner frames (10-phase). */
export const SPINNER_FRAMES: readonly string[] = Object.freeze([
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
]);

/** How many spinner ticks a single verb is held for (~2.4s at a 120ms tick). */
export const VERB_HOLD_TICKS = 20;

/** Pick a verb by (wrapped) index — safe for any integer, positive or negative. */
export function quantumVerb(index: number): string {
  const n = QUANTUM_VERBS.length;
  return QUANTUM_VERBS[((index % n) + n) % n] as string;
}

/** The braille frame for a tick. */
export function spinnerFrame(tick: number): string {
  const n = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((tick % n) + n) % n] as string;
}

/**
 * The live working line for a given tick. `seed` offsets which verb the turn starts on so two
 * consecutive turns don't always open on "Entangling". `caps='none'` degrades to a plain,
 * escape-free line (a static frame char) so piped/NO_COLOR output stays clean.
 */
export function workingLine(tick: number, elapsedMs: number, caps: ColorCaps, seed = 0): string {
  const verb = quantumVerb(seed + Math.floor(tick / VERB_HOLD_TICKS));
  const frame = caps === "none" ? "*" : spinnerFrame(tick);
  const secs = Math.max(0, Math.floor(elapsedMs / 1000));
  const meta = `(${secs}s · esc to interrupt)`;
  if (caps === "none") return `${frame} ${verb}… ${meta}`;
  return `${paint(frame, "accent", caps)} ${paint(`${verb}…`, "brand", caps)} ${paint(meta, "muted", caps)}`;
}
