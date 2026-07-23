# DMG installer window verification (issue #130)

Screenshots of the mounted, locally assembled (unsigned, never published)
layout-check DMG, captured from the pinned Finder window bounds
({200, 120, 840, 568} — content 640x420pt) after regenerating the artifacts
through the scripts. Two background variants for Tim to pick between
(orchestrator revision pass on PR #132 — "decisively blue, never gray"):

- **bold** (the committed default, `swift scripts/generate-dmg-background.swift`):
  lit brand blue → deep navy gradient, full-width tri-color deck-bar band
  along the top edge, stronger header glow + center light.
  - `dmg-window-bold-light.png` / `dmg-window-bold-dark.png`
- **steel** (restrained alternative,
  `swift scripts/generate-dmg-background.swift --variant steel`):
  desaturated-but-clearly-blue steel gradient, tri-color underline beneath
  the header lockup, softer lighting.
  - `dmg-window-steel-light.png` / `dmg-window-steel-dark.png`
  - `modeldeck-installer-bg-steel.png` is that variant's script-generated
    background (evidence only — the release input is always
    design/dmg/modeldeck-installer-bg.png).

What the captures verify:

- Both variants read branded blue at first glance — no default-gray reading.
- The dashed drop zone fully encloses the /Applications icon AND its label —
  no element overlap (the #130 complaint against the old dashed circle).
- Finder icon labels stay legible over the art in both appearances (the
  label band is held at ~0.15 relative luminance in both variants).
- Crisp at Retina at the pinned window size.

Regenerate after any art/layout change:

    swift scripts/generate-dmg-background.swift            # committed art
    swift scripts/generate-dmg-background.swift --variant steel
    scripts/generate-dmg-ds-store.sh                       # only if geometry changed

then rebuild a throwaway DMG (release-dmg.sh staging steps, unsigned) and
recapture. These images are evidence, not build inputs — release-dmg.sh
never reads this directory.
