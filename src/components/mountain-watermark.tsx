/**
 * A stylised drawing of Aoraki / Mt Cook from Lake Pukaki, from Jess's own
 * photo, behind Home's greeting (docs/TOHYEE-UI-SPEC.md, "Mountain
 * treatment"). Flat shapes in shades of the theme's accent blended with the
 * page colour, with pale snow, so it works in light and dark. Screen readers
 * skip it.
 */
export function MountainWatermark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1200 300" preserveAspectRatio="xMaxYMax meet" aria-hidden="true" focusable="false">
      <path d="M0,300 L0,170 L200,150 L330,120 L560,140 L620,128 L680,120 L720,104 L760,98 L800,80 L830,70 L860,78 L890,66 L925,74 L960,62 L1000,76 L1040,70 L1080,86 L1120,80 L1160,92 L1200,90 L1200,300 Z" style={{ fill: "color-mix(in srgb, var(--accent) 20%, var(--bg))" }} />
      <path d="M800,80 L830,70 L860,78 L845,96 L828,90 L812,104 Z M890,66 L925,74 L960,62 L948,84 L930,80 L915,96 L900,84 Z M1000,76 L1040,70 L1080,86 L1062,92 L1046,86 L1030,98 L1012,88 Z" style={{ fill: "var(--mtn-snow)" }} />
      <path d="M0,300 L0,198 L70,188 L120,168 L150,140 L172,150 L210,150 L260,138 L305,122 L350,98 L372,84 L392,70 L404,64 L414,56 L420,58 L432,30 L450,60 L456,66 L478,92 L505,104 L530,98 L560,110 L600,118 L640,110 L690,128 L740,130 L800,150 L860,170 L940,186 L1040,196 L1200,200 L1200,300 Z" style={{ fill: "color-mix(in srgb, var(--accent) 36%, var(--bg))" }} />
      <path d="M432,30 L440,62 L434,92 L426,112 L440,150 L470,170 L520,168 L505,104 L478,92 L456,66 L450,60 Z" style={{ fill: "color-mix(in srgb, var(--accent) 52%, var(--bg))" }} />
      <path d="M432,30 L420,58 L414,56 L404,64 L392,70 L372,84 L350,98 L328,110 L342,116 L356,110 L366,124 L382,114 L392,132 L406,118 L416,138 L426,112 L434,92 L440,62 Z M505,104 L530,98 L560,110 L546,116 L532,108 L518,118 Z M600,118 L640,110 L690,128 L668,130 L652,122 L636,132 L618,124 Z M120,168 L150,140 L172,150 L162,158 L150,152 L140,166 Z" style={{ fill: "var(--mtn-snow)" }} />
      <path d="M432,30 L450,60 L456,66 L478,92 L470,100 L458,92 L452,110 L444,88 L440,62 Z" style={{ fill: "color-mix(in srgb, var(--accent) 14%, var(--bg))" }} />
      <path d="M0,300 L0,214 L40,206 L110,222 L200,246 L300,262 L380,268 L380,300 Z M760,300 L800,252 L900,242 L1000,246 L1100,240 L1200,236 L1200,300 Z" style={{ fill: "color-mix(in srgb, var(--accent) 62%, var(--bg))" }} />
      <path d="M0,266 L1200,262 L1200,300 L0,300 Z" style={{ fill: "color-mix(in srgb, var(--accent) 46%, var(--bg))" }} />
      <path d="M368,118 L392,84 M391,128 L410,80 M414,134 L428,66 M452,104 L446,74" style={{ stroke: "color-mix(in srgb, var(--accent) 30%, var(--bg))", fill: "none" }} strokeWidth="3" strokeLinecap="round" />
      <path d="M120,276 L520,275 M700,282 L1100,280 M300,290 L620,289" style={{ stroke: "var(--mtn-snow)", fill: "none" }} strokeWidth="2" strokeOpacity="0.6" />
    </svg>
  );
}
