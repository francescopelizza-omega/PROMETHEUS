/**
 * icons/flame.tsx — the Prometheus brand mark (08 §2.5 custom set).
 *
 * Inline SVG, stroke/fill = currentColor so it tints from the active token (use
 * color: var(--brand)). aria-hidden by default — it is decoration beside a text
 * label that carries the meaning (08 §7: an icon is never the sole signal).
 */

import type { ReactElement, SVGProps } from "react";

export function Flame(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 3c0 4-3 5-3 8a3 3 0 0 0 6 0c0-1-1-2-1-3 2 1 4 3 4 6a6 6 0 0 1-12 0c0-5 6-7 6-11Z" />
    </svg>
  );
}

export default Flame;
