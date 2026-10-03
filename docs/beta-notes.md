**Beta for testing.** This is a pre-release with new features that may change or be removed before the next release. The stable version stays [the latest release](https://github.com/Audbol/CAL-Audio-Analyzer/releases/latest). Settings are shared with the stable version, so you can switch back at any time.

## Download

| System | File |
| --- | --- |
| **Windows 10/11** – installer | `CAL-Audio-Analyzer-1.11.0-beta.2-win-x64.exe` |
| **Windows 10/11** – portable (no install) | `CAL-Audio-Analyzer-1.11.0-beta.2-portable.exe` |
| **macOS** – Apple Silicon (M1–M4) | `CAL-Audio-Analyzer-1.11.0-beta.2-mac-arm64.dmg` |
| **macOS** – Intel | `CAL-Audio-Analyzer-1.11.0-beta.2-mac-x64.dmg` |
| **Linux** – x64 | `CAL-Audio-Analyzer-1.11.0-beta.2-linux-x86_64.AppImage` |
| **Linux** – ARM64 (e.g. Raspberry Pi 5) | `CAL-Audio-Analyzer-1.11.0-beta.2-linux-arm64.AppImage` |

The builds are not code-signed yet:

- **Windows:** if SmartScreen shows “Windows protected your PC”, click **More info → Run anyway**.
- **macOS:** open the .dmg and drag the app to Applications. The first time, right-click the app → **Open** → **Open**. If macOS says the app “is damaged”, run `xattr -dr com.apple.quarantine "/Applications/CAL Audio Analyzer.app"` in Terminal.
- **Linux:** `chmod +x CAL-Audio-Analyzer-*.AppImage`, then run it.

On first launch, choose **Explore with the demo room** to try every feature without hardware.

## New in beta 2

- **Several mics, several average curves:** with more than one mic, each average curve is drawn in its mic's colour (lightened, so it stands apart from the live trace) and with its own dash pattern (solid, long dash, dots, dash-dot). A single average curve stays white.
- **Reference toggle:** *Tools → Setup → Reference signal* switches every measurement between the internal generator reference and a loopback input (which input is remembered). The delay is measured again after switching.
- **Tidier Tools:** Tools is split into sections (Setup, Session & report, Remote access, Display & performance, Calculators, Data & reset), one at a time. The remote-access badge and *SPL → Calibrate…* open the right section.
- **Room modes tab:** the room mode calculator is its own tab (key **0**). The room's dimensions are now kept, and the last sweep is shown against the room's predicted axial modes. With the dimensions entered, the room diagnosis names the predicted mode a measured one matches.
- **SPL readout scales:** the SPL tab's sound level numbers grow and shrink with their panel when you drag a splitter, float, resize or detach it. The fourth reading shows the other time weighting (Slow when the readout is Fast).

## New in beta 1

- **Spectrum colours:** *Spectrum → Options → Colours* sets the colour of the trace (the line, or the tops of the bars) and of the fill (the area under the line, or the bodies of the bars): the measurement's own colour, a preset or any colour, and the fill opacity. The fill can also be turned off.
- **Detachable SPL panels:** the SPL tab's sound level readout, 2-minute history and noise log are now panels, like on the Spectrum tab. Rearrange and resize them, float one over the others, or detach it into its own window, for example the big level readout on a second screen. *Options* on the SPL tab shows or hides each panel and resets the layout. The history and the noise log are now shown together instead of as sub-tabs.
- **Room diagnosis:** after a sweep, *Sweep & Room → Diagnosis* explains what shapes the low and mid response, because each cause needs a different fix:
  - **Room modes:** narrow low-frequency peaks, confirmed when they keep ringing, with the room dimension that would cause them.
  - **Speaker-boundary interference (SBIR):** a strong early reflection from a nearby wall, floor or desk that cancels a low-mid band, with the distance to that boundary.
  - **Reflections:** distinct arrivals after the direct sound, with delay, extra path and the comb-filter notches they cause.
  - **Modal nulls:** narrow dips that depend on the position.

  Each finding says how sure it is (likely or possible) and what to do, and is marked on the frequency response and the impulse response / ETC.
- **Peak highlights:** the Spectrum tab marks the highest peak in the low (20–250 Hz), mid (250 Hz–4 kHz) and high (4–20 kHz) ranges, with its frequency and level, on the average curve when it is shown. A range without a real peak (for example a smooth roll-off) says "no peak". The *Peaks* button turns it off.

## Feedback

Tell us which of these to keep, change or drop. Each one is a separate change, so any of them can be removed on its own.
