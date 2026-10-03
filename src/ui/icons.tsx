// Inline stroke icons (24x24, currentColor).
import type { JSX } from 'preact';

const I = (d: string | JSX.Element) => (props: { size?: number }) => (
  <svg width={props.size ?? 22} height={props.size ?? 22} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {typeof d === 'string' ? <path d={d} /> : d}
  </svg>
);

export const IconCamera = I(
  <>
    <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
    <circle cx="12" cy="13" r="3.5" />
  </>,
);
export const IconGlasses = I(
  <>
    <ellipse cx="6.5" cy="13" rx="4" ry="3.2" />
    <ellipse cx="17.5" cy="13" rx="4" ry="3.2" />
    <path d="M10.5 12.5c1-.8 2-.8 3 0M2.5 12 1 9M21.5 12 23 9" />
  </>,
);
export const IconCheck = I('M4 12.5l5 5L20 6.5');
export const IconSteps = I(
  <>
    <rect x="3" y="4" width="7" height="7" rx="1.5" />
    <rect x="14" y="4" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <path d="M14 17.5h7M17.5 14v7" />
  </>,
);
export const IconHelp = I(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01" />
  </>,
);
export const IconImage = I(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="2" />
    <path d="m21 16-5-5-9 9" />
  </>,
);
export const IconDownload = I('M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14');
export const IconClose = I('M6 6l12 12M18 6 6 18');
export const IconFlash = I('M13 3 5 14h6l-1 7 8-11h-6z');
export const IconSun = I(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </>,
);
export const IconTrash = I('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3');
export const IconSpark = I('M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6');
