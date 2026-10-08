# Aoraki header refinement

`public/images/aoraki-restored.webp` is an AI-restored decorative derivative of the existing `aoraki-strip.jpg`, made with the built-in image-generation editing tool. The original crop remains unchanged. Restoration reconstructs fine photographic detail and should not be described as the untouched original or a geographically exact reconstruction.

Only the existing landscape strip was supplied. The full screenshot, browser chrome and identifying foreground are not included. The output was encoded as WebP for delivery (about 99 KB). CSS keeps the photographic blue tones at 28% opacity, fades all four edges, and gives greeting text a solid canvas background. Decoration is hidden below 768px and in print.

Prompt used:

> Edit target: the attached narrow photographic crop of Aoraki / Mount Cook seen across Lake Pukaki. Restore this exact photograph, removing the vertical screen scanlines, moire rainbow interference, and monitor texture. Preserve the exact mountain silhouette, relative peak positions, snow locations, lake horizon and composition; do not invent a different mountain or new scenery. Keep the panoramic framing, natural muted blue lake, cool blue-grey mountain shadows and pale sky. Clean restrained photographic restoration, not illustration, no text, no borders. Intended as a small decorative website header background. Only repair the image texture, preserving the original identifiable geography.

Browser fixture checks cover 1440, 1280, 1024, 768 and 390px widths, containment within the header, decorative semantics, no pointer interception, phone hiding and long-greeting background protection. These render the real header component and CSS independently of authentication.
