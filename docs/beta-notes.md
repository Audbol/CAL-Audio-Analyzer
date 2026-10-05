**Release candidate for version 2.0.** Please try it on your own systems before 2.0 is released: everything below is in it, and only fixes are planned from here. The stable version stays [the latest release](https://github.com/Audbol/CAL-Audio-Analyzer/releases/latest). Settings are shared with it, so you can switch back at any time.

## Download

| System | File |
| --- | --- |
| **Windows 10/11** – installer | `CAL-Audio-Analyzer-2.0.0-rc.3-win-x64.exe` |
| **Windows 10/11** – portable (no install) | `CAL-Audio-Analyzer-2.0.0-rc.3-portable.exe` |
| **macOS** – Apple Silicon (M1–M4) | `CAL-Audio-Analyzer-2.0.0-rc.3-mac-arm64.dmg` |
| **macOS** – Intel | `CAL-Audio-Analyzer-2.0.0-rc.3-mac-x64.dmg` |
| **Linux** – x64 | `CAL-Audio-Analyzer-2.0.0-rc.3-linux-x86_64.AppImage` |
| **Linux** – ARM64 (e.g. Raspberry Pi 5) | `CAL-Audio-Analyzer-2.0.0-rc.3-linux-arm64.AppImage` |

The builds are not code-signed yet:

- **Windows:** if SmartScreen shows “Windows protected your PC”, click **More info → Run anyway**.
- **macOS:** open the .dmg and drag the app to Applications. The first time, right-click the app → **Open** → **Open**. If macOS says the app “is damaged”, run `xattr -dr com.apple.quarantine "/Applications/CAL Audio Analyzer.app"` in Terminal.
- **Linux:** `chmod +x CAL-Audio-Analyzer-*.AppImage`, then run it.

On first launch, choose **Explore with the demo room** to try every feature without hardware.

## What's new in 2.0

**A faster start for transfer-function work.** The app now opens on the transfer function at 1/12 octave, with coherence drawn in its own band across the top of the magnitude graph and phase below. The delay is found by itself the first time the coherence is low, the level meters live in the status bar, and the Spectrum shows a 1/6-octave line with a 10-second average curve and its real peaks labelled.

### Measure
- **Group delay:** *Transfer → Options → Panels → Group delay* shows how late each frequency arrives, in milliseconds (a sub behind the mains, a crossover's delay), weighted by energy and coherence so dips and noise don't hide the real delay.
- **Measure at several positions:** *Sweep & Room → Positions* runs one sweep per mic position, tells you where to move the mic in between, and saves the spatial average as a trace for the EQ tab. It works from a phone or tablet too.
- **Feedback finder:** *Feedback* on the Spectrum toolbar listens for narrow peaks that grow or ring, warns with the frequency, and suggests a notch filter (frequency, Q, depth) that one click puts on the EQ tab.
- **Room diagnosis:** after a sweep, *Diagnosis* separates room modes, speaker-boundary interference, reflections and modal nulls, says how sure it is and what to do, and marks them on the graphs.
- **Sweeps on the Spectrum:** saved sweeps also show on the Spectrum, levelled to the live curve.
- **3-D waterfall:** drag the waterfall to turn it, zoom with the wheel, or jump to the front, side or a view from above.
- **Reference switch:** *Tools → Setup → Reference signal* switches every measurement between the generator and a loopback input.

### Tune and document
- **Crossover designer:** *Align → Crossover* tries Linkwitz-Riley and Butterworth filters (6–48 dB/oct) on the measured sub and mains, with the sub's level and polarity, and aligns them through it. Each change re-aligns at once, so slopes and frequencies can be compared by their sum.
- **FIR export:** *EQ → Export FIR…* saves the EQ as an impulse response (WAV, 32-bit float or 24-bit, or a coefficient list) for convolution, minimum or linear phase, at the processor's sample rate. It shows how closely the filter follows the EQ at the chosen length.
- **Compare before / after:** *Compare* above the Traces list puts two traces on one graph with the change between them and a score against the target, such as "±4.1 dB → ±1.8 dB RMS from 40 Hz to 8 kHz (56 % closer to the target)". It can be a page of the report.
- **Notes on graphs:** drop labelled flags on the Spectrum, Transfer and sweep graphs. They are saved with the session, shared with remote devices, and drawn on and listed in the report.
- **Spectrum peaks:** the highest real peak in the low, mid and high ranges is labelled.
- **Several mics:** each mic's average curve has its own colour and dash pattern.

### Smoother and faster
- **Background analysis:** the spectrum, transfer function and impulse response are computed in a separate thread, so drawing never waits for the maths. The main thread's work per frame is less than half of what it was.
- **Meters at the screen's rate:** the level meters move on every frame with proper ballistics (instant rise, 20 dB/s fall, 1.5 s peak hold) and colours at fixed levels.
- **Gliding spectrum:** the curve glides from one spectrum to the next (*Options → Motion*), with an optional 50 spectra per second (*Options → Updates*). *Averaging: None* is truly instant, and the panel shows how long each averaging setting takes.
- **Lighter start:** the report and the QR code load when first used; graphs cache their grid and labels.

### Look and layout
- **Themes:** besides Night and Day, ready-made *High contrast*, *Stage red*, *Colour-blind safe*, *Midnight blue* and *Paper* themes, and your own from a theme editor (background, panels, text, accent, graph and grid colours, and trace colours), with a live preview. Themes can be exported and shared.
- **Guided tour:** a one-minute walk through the essentials, offered by the Assistant at the first start and always in Help.
- **Updates you control (desktop app):** *Tools → About & data → Check for updates* finds a new version, *Download* fetches it and *Restart to update* installs it. Nothing happens on its own, so an update can never interrupt a show; automatic checks can be turned on and only notify. *What's new* shows the highlights after an update to a new major version.
- **Watermark:** *Tools → Display & performance → Watermark* puts your logo faintly on every graph, and so on screenshots and reports.
- **Level meters for what's in use:** the status bar shows meters only for the inputs the app uses, and the generator while it plays or serves as the reference.
- **Colours:** choose the Spectrum's trace and fill colours and the fill opacity.
- **SPL tab:** the level readout, history and noise log are panels you can float or detach (for example the big readout on a second screen), and the numbers scale with their panel.
- **Tools:** split into sections (Setup, Session & report, Remote access, Display & performance, Calculators, About & data); the room-mode calculator is under *Calculators*.
- **Tidier menus:** the Spectrum options are grouped into Analysis, Display, Average curve and Overlays; empty graphs say what to do; the Assistant can be hidden.
- **Fixes:** level meters showed warning colours at low levels; trace buttons could run past the sidebar on narrow screens; several toolbar, axis and dialog details.
