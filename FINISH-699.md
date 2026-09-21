# Issue #699 completion

Option **(a): test-only correction**. The visibility assertion discarded visible antialiased text by demanding alpha greater than 0.8. On macOS 27 the Aqua percent has only 18 such pixels, but 65 pixels at alpha >= 0.5. The production renderer is unchanged.

## Diagnosis

Reproduced on macOS 27.0 build 26A428 with local Swift 6.4 (the brief reported Swift 6.3.3). The unchanged renderer suite failed exactly as reported: `pinnedStateShowsANeutralAdaptivePercent`, Aqua count 18, required >20. The other eight tests passed.

A temporary scratch test rasterized pinned `52%`, the plain glyph on the same-size transparent canvas, and the same text/font in solid black. It dumped every alpha-byte count under Aqua and Dark Aqua and wrote PNGs under `/tmp`. The scratch test was removed after diagnosis.

The renderer uses `NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)`, resolved here as `.SFNS-Semibold`. The measured `52%` text width/advance is 25.57600498 points, height 14. The image is 45 x 16 points: 16-point glyph + 3-point gap + ceil(25.576). Thus x=19 is the first text column. Both appearances occupy x=19...43, y=3...12, with the last image column still empty. No clipping or appearance-dependent width loss was found.

`labelColor` resolves to black in Aqua and white in Dark Aqua, with alpha 216/255 (0.847059) in both. The >0.8 cutoff is consequently very close to the maximum text opacity and excludes most antialiased pixels. Alpha sums are 66.4314 in Aqua and 81.7843 in Dark Aqua; both use the same geometry. Drawing the same font in solid black gives 43 pixels above 0.8 and 75 at or above 0.5 in both appearances, with identical bounds. This supports an opacity/rasterization-sensitive assertion, not a missing or clipped percent or a reason to change the font weight. The PNGs were inspected; both contain the full `52%`.

No macOS 26 raster was available, so an exact historical font/antialiasing change cannot be established from this run. The measured difference is the distribution of alpha under the two current appearances, not a proven change in font advance across OS versions.

## Alpha histogram

416 pixels sampled in each text region (26 x 16). Bins use the actual 8-bit alpha values.

| Image | 0 | 1–63 | 64–127 | 128–204 | 205–255 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Aqua pinned | 266 | 42 | 43 | 47 | 18 |
| Aqua plain control | 416 | 0 | 0 | 0 | 0 |
| Dark Aqua pinned | 241 | 53 | 35 | 46 | 41 |
| Dark Aqua plain control | 416 | 0 | 0 | 0 | 0 |

## Change and before/after counts

Only `macos/ModelDeckMac/Tests/ModelDeckMacCoreTests/MenuBarIconRendererTests.swift` changed. The pinned visibility/color loop now accepts alpha >=0.5, matching the existing visible-pixel helper. It still requires >20 pixels and still checks neutrality and light/dark adaptation. A comment records the macOS 27 counts.

| Image | Before: alpha >0.8 | After: alpha >=0.5 |
| --- | ---: | ---: |
| Aqua pinned | 18 (failed) | 65 (passes) |
| Dark Aqua pinned | 41 | 87 |
| Aqua plain control | 0 | 0 |
| Dark Aqua plain control | 0 | 0 |

The test permanently asserts that a plain glyph drawn at its natural size on the pinned image's canvas has zero visible pixels in the text region under both appearances. This avoids a vacuous empty scan of the 16-point plain image.

## Verification

- Original renderer suite: 9 tests, 1 failure, Aqua count 18.
- Corrected renderer suite: 9 tests passed.
- Negative experiment: temporarily fed that same-size plain control into the pinned visibility measurement. The >20 assertion failed with count 0 under **both** appearances. The experiment was then reverted.
- Final renderer suite after restoring the real pinned measurement: **9 tests passed, 0 failures**, exit 0.

Command, from the worktree root:

```sh
SWIFTPM_MODULECACHE_OVERRIDE=/tmp/modeldeck-699-module-cache \
CLANG_MODULE_CACHE_PATH=/tmp/modeldeck-699-module-cache \
swift test --package-path macos/ModelDeckMac --disable-sandbox \
  --disable-automatic-resolution --skip-update \
  --cache-path /tmp/modeldeck-699-spm-cache \
  -Xswiftc -module-cache-path -Xswiftc /tmp/modeldeck-699-module-cache \
  --filter MenuBarIconRenderer
```

Reused local Sparkle 2.8.0 checkout/artifact caches copied into this worktree's ignored `.build` directory to build offline. No dependency or manifest changes. The full 1837-test suite was not run; verification is scoped to the requested renderer tests and avoids unrelated live-resource tests.

Evidence logs: `/tmp/modeldeck-699-before.log`, `/tmp/modeldeck-699-probe.log` (full alpha histogram), `/tmp/modeldeck-699-after.log`, `/tmp/modeldeck-699-empty-control.log`, `/tmp/modeldeck-699-final.log`.

No git command, network request, provider call, live app/daemon/Keychain operation, or live-port probe was performed.
