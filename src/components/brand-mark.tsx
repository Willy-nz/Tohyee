/**
 * Tohyee's dog, drawn inline at small sizes for the top bar and sign-in
 * pages (the same drawing as src/app/icon.svg, on the app's accent green).
 */
export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 512 512" aria-hidden focusable="false">
      <rect width="512" height="512" rx="128" fill="var(--brand, #0e7467)" />
      <path d="M112 236 L142 70 Q150 52 166 64 L250 150 Z" fill="#ffffff" />
      <path d="M400 236 L370 70 Q362 52 346 64 L262 150 Z" fill="#ffffff" />
      <path d="M144 196 L160 98 L214 152 Z" fill="#f4b6c2" />
      <path d="M368 196 L352 98 L298 152 Z" fill="#f4b6c2" />
      <path
        d="M256 128 C 330 128 390 168 408 230 C 438 244 452 276 436 300 C 458 322 452 356 426 368 C 432 400 408 428 376 426 C 364 456 330 470 300 456 C 286 476 226 476 212 456 C 182 470 148 456 136 426 C 104 428 80 400 86 368 C 60 356 54 322 76 300 C 60 276 74 244 104 230 C 122 168 182 128 256 128 Z"
        fill="#ffffff"
      />
      <ellipse cx="256" cy="352" rx="78" ry="58" fill="#eef2f0" />
      <ellipse cx="194" cy="284" rx="24" ry="19" transform="rotate(14 194 284)" fill="#111827" />
      <ellipse cx="318" cy="284" rx="24" ry="19" transform="rotate(-14 318 284)" fill="#111827" />
      <path d="M232 324 Q256 312 280 324 Q282 344 256 356 Q230 344 232 324 Z" fill="#111827" />
    </svg>
  );
}
