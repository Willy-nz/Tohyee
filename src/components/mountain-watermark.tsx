/**
 * A stylised drawing of the Southern Alps from Jess's own photo (Lake Pukaki
 * looking towards Aoraki), drawn as flat shapes for a faint watermark behind
 * Home's greeting (docs/TOHYEE-UI-SPEC.md, "Mountain treatment"). It uses
 * the theme's colours, so it works in light and dark, and screen readers skip it.
 */
export function MountainWatermark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1855 360" preserveAspectRatio="xMaxYMax meet" aria-hidden="true" focusable="false">
      <path d="M0,186 L60,180 L100,168 L140,146 L175,124 L192,132 L206,140 L222,160 L238,170 L262,160 L290,158 L320,176 L355,196 L385,166 L420,128 L455,104 L490,82 L520,66 L545,56 L560,64 L578,74 L605,92 L632,110 L648,98 L660,92 L675,104 L700,128 L730,130 L760,134 L800,150 L840,168 L862,182 L880,186 L910,166 L940,150 L970,142 L1000,140 L1030,144 L1060,146 L1085,132 L1110,120 L1150,96 L1190,72 L1215,66 L1240,66 L1265,76 L1290,84 L1305,76 L1320,72 L1350,74 L1380,80 L1400,92 L1420,96 L1455,82 L1490,72 L1520,64 L1545,57 L1562,66 L1580,74 L1615,88 L1650,98 L1685,86 L1720,76 L1755,84 L1790,94 L1825,98 L1855,104 L1855,338 L0,344 Z" fill="currentColor" fillOpacity="0.1" />
      <path d="M0,205 C7,204 20,194 40,199 C60,204 85,220 120,236 C155,252 207,278 250,294 C293,310 343,326 380,334 C417,342 455,342 470,344 L0,344 Z" fill="currentColor" fillOpacity="0.16" />
      <path d="M128,152 L175,124 L206,140 L214,152 L196,148 L178,156 L160,146 L144,156 Z M436,118 L490,82 L545,56 L578,74 L605,92 L586,90 L566,100 L548,88 L528,102 L500,96 L476,110 L456,108 Z M1528,66 L1545,57 L1562,66 L1574,74 L1556,72 L1542,78 Z M1200,70 L1215,66 L1240,66 L1252,72 L1232,74 L1214,78 Z" style={{ fill: "var(--bg)" }} fillOpacity="0.85" />
      <path d="M0,344 L1855,338 M120,352 L520,350 M900,350 L1500,348" stroke="currentColor" strokeOpacity="0.16" strokeWidth="2" fill="none" />
    </svg>
  );
}
