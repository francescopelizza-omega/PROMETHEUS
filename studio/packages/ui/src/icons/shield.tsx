/**
 * icons/shield.tsx — the nemesis security mark (08 §2.5 custom set).
 *
 * Inline SVG, currentColor — tint it with the verdict role (var(--ok/--warn/
 * --danger)) so the ambient shield (§4.2) reads the latest gate tier. Decorative
 * by default; the surrounding control carries the accessible name (08 §7).
 */

import type { ReactElement, SVGProps } from "react";

export function Shield(props: SVGProps<SVGSVGElement>): ReactElement {
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
      <path d="M12 3 4 6v6c0 4 3.5 7 8 9 4.5-2 8-5 8-9V6Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export default Shield;
