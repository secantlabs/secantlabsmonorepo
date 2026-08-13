/**
 * Sponsor credit that floats at the bottom-right of the graph on the
 * standalone app. Rendered only when NOT embedded (see App/Warp3D), so it
 * never shows inside a Warp Lessons scene.
 *
 * The mark is the official germinate.ai logo icon, inlined from
 * https://germinate.ai/germinate-ai-logo-icon.svg — small enough (under 1 KB)
 * that inlining beats a second network request, and it stays crisp at any
 * size. The source file carries its fills via a <style> block with generic
 * .cls-1/.cls-2 names; those are set per-path here so they can't collide with
 * anything else on the page.
 */
function GerminateMark() {
  return (
    <svg
      className="germinate-mark"
      viewBox="0 0 63.93 55.21"
      width="22"
      height="19"
      aria-hidden="true"
    >
      {/* large leaf */}
      <path
        fill="#669740"
        fillRule="evenodd"
        d="M57.48,52.39c-.23,1.77-1.86,3.02-3.64,2.79l-29.37-3.87c-2.5-.33-3.68-3.26-2.11-5.24L58.15,1.23c2.05-2.57,6.18-.81,5.75,2.45l-6.42,48.71Z"
      />
      {/* small leaf */}
      <path
        fill="#98c93c"
        fillRule="evenodd"
        d="M1.96,35.35c.18,1.78,1.76,3.08,3.55,2.91l15.79-1.57c2.71-.27,3.9-3.56,1.99-5.5L5.55,13.18C3.41,11-.28,12.73.02,15.77l1.94,19.58Z"
      />
    </svg>
  );
}

export default function GerminateCredit() {
  return (
    <a
      className="germinate-credit"
      href="https://germinate.ai"
      target="_blank"
      rel="noopener noreferrer"
    >
      <GerminateMark />
      <span>Supported by Germinate.AI</span>
    </a>
  );
}
