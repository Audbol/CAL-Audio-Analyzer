**Beta for testing.** This is a pre-release with new features that may change or be removed before the next release. The stable version stays [the latest release](https://github.com/Audbol/CAL-Audio-Analyzer/releases/latest). Settings are shared with the stable version, so you can switch back at any time.

## Download

| System | File |
| --- | --- |
| **Windows 10/11** – installer | `CAL-Audio-Analyzer-1.11.0-beta.5-win-x64.exe` |
| **Windows 10/11** – portable (no install) | `CAL-Audio-Analyzer-1.11.0-beta.5-portable.exe` |
| **macOS** – Apple Silicon (M1–M4) | `CAL-Audio-Analyzer-1.11.0-beta.5-mac-arm64.dmg` |
| **macOS** – Intel | `CAL-Audio-Analyzer-1.11.0-beta.5-mac-x64.dmg` |
| **Linux** – x64 | `CAL-Audio-Analyzer-1.11.0-beta.5-linux-x86_64.AppImage` |
| **Linux** – ARM64 (e.g. Raspberry Pi 5) | `CAL-Audio-Analyzer-1.11.0-beta.5-linux-arm64.AppImage` |

The builds are not code-signed yet:

- **Windows:** if SmartScreen shows “Windows protected your PC”, click **More info → Run anyway**.
- **macOS:** open the .dmg and drag the app to Applications. The first time, right-click the app → **Open** → **Open**. If macOS says the app “is damaged”, run `xattr -dr com.apple.quarantine "/Applications/CAL Audio Analyzer.app"` in Terminal.
- **Linux:** `chmod +x CAL-Audio-Analyzer-*.AppImage`, then run it.

On first launch, choose **Explore with the demo room** to try every feature without hardware.

## New in beta 5

Smoother metering:

- **Level meters at the full screen rate:** the input and generator meters (status bar and the *Input levels* panel) now move on every frame with meter ballistics: they rise at once, fall back smoothly at 20 dB per second, and hold the highest peak for 1.5 s. A short peak between two frames is never missed.
- **The spectrum glides:** a new spectrum arrives 25 times a second; the curve now glides from one to the next on every screen refresh instead of jumping (about 40 ms behind). *Spectrum → Options → Motion* switches back to *Stepped*. Remote devices profit most: the host's spectra reach them 10–25 times a second.
- **50 spectra per second:** *Spectrum → Options → Updates* computes twice as many spectra, for a display that follows changes faster, at about twice the processing. The averaging time stays the same.
- **Analysis in a background thread:** the spectrum and transfer function are now computed in a separate thread beside the drawing, so neither waits for the other (fewer hiccups when you resize or detach panels or build a report). In the demo the main thread's work per frame halves. *Tools → Display & performance → Analysis* switches back to the main thread; if a computer can't run the background thread, the app falls back by itself. The status bar shows the time spent in each.

## New in beta 4

- **Group delay:** *Transfer → Options → Panels → Group delay* adds a graph of how late each frequency arrives, in milliseconds, for example a sub 10 ms behind the mains, or the extra delay of a crossover. It is smoothed over 1/6 octave and weighted by energy and coherence, so dips and noise don't hide the real delay.
- **Measure at several positions:** *Sweep & Room → Positions* (3–8) runs one sweep per mic position. Between sweeps the app tells you where to move the mic, and at the end it saves the spatial average as a trace for the EQ tab (each position is kept as a hidden trace). You can finish early after two positions, and it works from a remote device too.
- **Compare before / after:** *Compare* above the Traces list puts two traces on one graph with the change between them, and scores each against a target: RMS deviation, share within the tolerance and the worst point, for example "±4.1 dB → ±1.8 dB RMS from 40 Hz to 8 kHz (56 % closer to the target)". *Match levels* compares shape only. The comparison can be a page of the report.
- **Notes on graphs:** *Note* in the Spectrum, Transfer and Sweep & Room toolbars, then click the graph to drop a labelled flag ("desk reflection", "sub moved 20 cm"). Click a flag to change or delete it. Notes are saved with the session, appear on every connected device, and are drawn on the report's graphs and listed in it.

## New in beta 3

- **Room modes in Tools → Calculators:** the room mode calculator is back under *Tools → Calculators* instead of its own tab. It keeps the room's dimensions and shows the last sweep against the predicted axial modes.
- **Averaging "None" is instant:** on the Spectrum, *Averaging: None* now shows each new spectrum as it is, with no smoothing between frames. *Spectrum → Options → Averaging* shows how long each setting takes to follow a change (for example "≈ 0.7 s" for 4 with a 16k FFT at 48 kHz). The screen still updates just as often; more averaging only makes the curve steadier and slower to follow changes.
- **Hide the Assistant:** the × on the Assistant in the sidebar hides it, and the traces get the space. *Tools → Display & performance → Assistant* shows it again.
- **Sweeps on the Spectrum:** a sweep saved with *Sweep & Room → Save FR as trace* now shows on the Spectrum as well as on Transfer. A sweep measures the shape of the response, not a sound level, so on the Spectrum it is moved to sit on the live curve (same average level from 250 Hz to 4 kHz). *Spectrum → Options → Sweeps* turns this off, and the eye in the trace list hides a sweep everywhere.

## New in beta 2

- **Several mics, several average curves:** with more than one mic, each average curve is drawn in its mic's colour (lightened, so it stands apart from the live trace) and with its own dash pattern (solid, long dash, dots, dash-dot). A single average curve stays white.
- **Reference toggle:** *Tools → Setup → Reference signal* switches every measurement between the internal generator reference and a loopback input (which input is remembered). The delay is measured again after switching.
- **Tidier Tools:** Tools is split into sections (Setup, Session & report, Remote access, Display & performance, Calculators, Data & reset), one at a time. The remote-access badge and *SPL → Calibrate…* open the right section.
- **Room modes:** the room's dimensions are now kept, and the last sweep is shown against the room's predicted axial modes. With the dimensions entered, the room diagnosis names the predicted mode a measured one matches.
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
