Professional real-time sound system and room acoustics analyzer: RTA and spectrum, dual-channel transfer function with coherence and phase, spectrogram, impulse response, log-sweep room acoustics (RT60 / EDT / C50 / C80), EQ assistant, calibrated SPL meter, and remote access from phones and tablets.

## Download

| System | File |
| --- | --- |
| **Windows 10/11** – installer | `CAL-Audio-Analyzer-<version>-win-x64.exe` |
| **Windows 10/11** – portable (no install) | `CAL-Audio-Analyzer-<version>-portable.exe` |
| **macOS** – Apple Silicon (M1–M4) | `CAL-Audio-Analyzer-<version>-mac-arm64.dmg` |
| **macOS** – Intel | `CAL-Audio-Analyzer-<version>-mac-x64.dmg` |
| **Linux** – x64 | `CAL-Audio-Analyzer-<version>-linux-x86_64.AppImage` |
| **Linux** – ARM64 (e.g. Raspberry Pi 5) | `CAL-Audio-Analyzer-<version>-linux-arm64.AppImage` |

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
- **Colours and gradients:** choose the Spectrum's trace and fill colours, the fill opacity and a fill style for the line and the bars: solid, fading downwards, coloured by level (green to red) or by frequency (a rainbow from bass to treble).
- **SPL tab:** the level readout, history and noise log are panels you can float or detach (for example the big readout on a second screen), and the numbers scale with their panel.
- **Tools:** split into sections (Setup, Session & report, Remote access, Display & performance, Calculators, About & data); the room-mode calculator is under *Calculators*.
- **Tidier menus:** the Spectrum options are grouped into Analysis, Display, Average curve and Overlays; empty graphs say what to do; the Assistant can be hidden.
- **Fixes:** level meters showed warning colours at low levels; trace buttons could run past the sidebar on narrow screens; several toolbar, axis and dialog details.

## What's new in 1.10.1

- **User guide:** a complete, plain-language [user guide](https://github.com/Audbol/CAL-Audio-Analyzer/blob/HEAD/docs/user-guide.md) with screenshots, from installing to reports, with an accessibility section, keyboard shortcuts, troubleshooting and a glossary.
- **Accessibility:**
  - Every button, list and input now has a name that screen readers read out (lists take the label shown next to them, icon buttons their tooltip).
  - Messages are announced as they appear, warnings straight away. New tips from the Assistant are announced once, not each time a number in them changes.
  - Fields that share a label (such as a frequency range) have names of their own.
- **Fixes:**
  - A phone or tablet that connected right after the measurement computer's analysis restarted (for example when the generator signal changed) could show an empty spectrum with its scale stuck far below the data, when a calibrated mic was in use. Empty analysis frames are now skipped.
  - The Transfer tab's smoothing list now follows a workspace that changes the smoothing.
  - With a reference delay, the bass part of the transfer function (High or Maximum bass resolution) waited for that delay before updating: with 100 ms of delay it reacted 100 ms late. It now keeps up with the rest.
  - The EQ assistant stopped altogether when the biggest deviation was a dip it wasn't allowed to boost (Max boost 0 dB). It now moves on and still cuts the peaks.
  - The Waterfall could freeze the tab with a very short impulse response.
  - Before a measurement had any spectrum (just after a reset), calibrated mics could add a flat, false curve to the several-mic average and to the target's levelling.
  - Changing the air temperature in Tools now updates the room-mode calculator straight away.

## What's new in 1.10

- **Average curve your way:** hide or show the average curve with the eye button next to *Average* (it keeps averaging while hidden, so the target stays levelled), and choose its colour and thickness under *Options → Average curve*.
- **Battery saver:** *Tools → Display & performance → Battery saver*. *Auto* (the default) turns it on while a laptop, tablet or phone runs on battery; *On* keeps it on. It draws about 15 times per second instead of 60, computes 10 new spectra per second instead of 25, draws graphs at standard resolution and sends remote devices 10 updates per second. Measurements stay exact: every audio sample is still analysed, and the SPL meter and noise log are not affected. The status bar shows when it is on.
- **Target curves on Sweep & Room:** pick a target (built-in or a stored trace) next to the result tabs. It is drawn with its tolerance band over the swept frequency response, levelled to the response, and has its own choice separate from the live views.
- **Reset to defaults:** *Tools → Reset analysis & display to* resets the analysis and display settings to the *App defaults* or to a *Classic dual-FFT* setup (1/12-octave transfer function, 16 averages, coherence, ±18 dB scale, high-resolution spectrum). Microphones, calibrations, inputs, remote access and saved workspaces stay as they are. *Reset all settings* still starts completely fresh.
- **Fixes and tuning:**
  - The average curve took each new spectrum into account twice when analysing locally, so its time constant differed slightly from what remote devices showed.
  - Changing the noise log interval no longer drops the unfinished row. At sample rates below 44.1 kHz the log's band columns stay aligned in the CSV (bands the sample rate can't measure are left blank).
  - The remote-access server no longer stops when a device sends a message over its size limit. Song uploads over 60 MB are refused on the device with a message instead.
  - Reconnecting a remote device, or restarting remote access, no longer leaves a stale connection behind.
  - A sweep started from a remote device now reports an error if it can't be played, instead of waiting forever.
  - A sweep interrupted by an audio restart now stops with a message instead of producing a wrong result.
  - With ASIO, generator samples the driver couldn't take at once are played later instead of skipped, so sweeps stay intact.
  - Averaging RTA traces from mics with different calibrations converts each to dB SPL first.
  - Calibrating a mic with an empty reference level is refused instead of calibrating to 0 dB SPL.
  - The EQ source now follows the measurement itself, not its position in the list.
  - A session file with a damaged sweep is refused before anything is changed.
  - Opening sessions with many traces is faster.
  - The audio thread does less work per sample.
  - A second launch of the desktop app only brings the running one to the front.
  - Unused code has been removed.

## What's new in 1.9.1

- **SPL meter and noise log measured sample-exactly:** the meter and log are now computed entirely from the audio samples, independent of the screen, its refresh rate and the analysis settings. Each log row covers exactly its interval (to the sample), Lmax is tracked on every sample, the 2-minute history is recorded every 100 ms of audio, and the log's third-octave bands come from their own IEC 61260-style band filters instead of the spectrum display. The numbers update at a steady 4 per second so they are easy to read. While a noise log runs, its weighting and input are locked, and switching workspace no longer changes them; every row records its weighting, which is also in the CSV.
- **Remote devices show the target and average curves:** the host's target curve, tolerance, average curve and multi-mic average settings now apply on connected phones and tablets, and the average curve is drawn from the host's analysis.
- **Faster spectrum:** the spectrum updates about 25 times per second (was about 6) with the same frequency resolution; *Avg* keeps the same averaging time. Remote devices receive 20 updates per second.

## What's new in 1.9

- **Several microphones, each calibrated:** *Tools → Microphones & calibration* keeps a list of your measurement mics: the input each one is plugged into, its correction file and its own SPL calibration (calibrator or reference meter, through the meter's weighting). Every view uses the mic on its input: the spectrum shows each measurement in dB SPL with its own calibration, the SPL meter and noise log follow the mic on their input, and the input lists show the mic names. Settings from earlier versions become the first mic.
- **System alignment:** the Align tab now aligns the whole system to the mains: subs, front fills, out fills and delay speakers. Subs are aligned for summation through the crossover; fills and delay speakers for arrival across their overlap band (also 100+ ms for delay towers), with a precedence setting so the sound stays on stage. Each part can use the mains measured at its own handoff position. The result is an alignment plan (delay, polarity, level vs mains, summation) that goes into sessions and reports, with a warning when a speaker already arrives too late to fix with delay.
- **A more polished look:** bundled Inter and JetBrains Mono fonts (sharper, consistent on every system, also offline), refined graphite surfaces, consistent control sizes, focus rings, quieter scrollbars, clearer trace rows, fewer stacked messages, and no more emoji in the input list. Fixed: with many traces, the trace list ran under the assistant.

## What's new in 1.8

- **ASIO (Windows):** choose *ASIO: <your interface>* as the input source to use the interface's ASIO driver directly: every input and output channel, the driver's low latency, no system mixer or resampling. Set the sample rate, buffer size and safety margin, and open the driver's control panel, in *Tools → Audio interface (ASIO)*. The generator signal that was actually played is recorded in the same driver callback as the inputs, so the internal reference stays sample-aligned with your microphones.
- **Smoother average curve:** the Spectrum's average line is now smoothed with a natural, bell-shaped window (1/6 octave by default; 1/12, 1/3, 1/1 or none under *Options → Average curve*), and it is drawn as a smooth curve over bars too.
- **Several mics at once:** *Options → Several mics* on the Spectrum and Transfer tabs shows the live power average of all measurement mics, with the spread between them as a band, or the average alone.
- **Noise log (SPL tab):** log Leq and Lmax every 1 s to 15 min with the third-octave spectrum, for hours. Set a level limit on the rolling Leq (e.g. 100 dB LAeq,15min); the level readout turns amber near it and red above it, with a warning. Export CSV; included in sessions and reports.
- **Waterfall (Sweep & Room):** cumulative spectral decay in 3-D, for room modes or the full range, also in the report.
- **Trace notes and photos:** attach a note and a photo of the mic position to any trace; shown in reports and kept in sessions.
- **Cleaner screens:** every tab now fits its controls in one row, even on a laptop. Everyday controls stay in the toolbar; less-used settings (FFT size, averaging, curve smoothing, target tolerance, several mics, panels, sweep options, EQ limits, alignment region) moved under *Options*. The SPL tab shows the 2-minute history or the noise log, one at a time; shorter tab names (EQ, SPL) and a compact workspace button make room in the tab bar.
- **Workspaces:** ready-made setups for live mixing, system tuning, sub alignment, voice systems, room surveys and noise monitoring, plus your own saved workspaces (with panel layouts), from the picker at the right of the tabs.

## What's new in 1.7

- **Target curves:** choose a target (Flat, House, Tilt, X-curve or any stored trace) on the Spectrum or Transfer tab. It is drawn as a dashed line with a ±1–6 dB tolerance band and levels itself to the measurement, so you can see at a glance where the system is outside the target.
- **Sub / main alignment assistant (new Align tab):** capture the mains alone and the sub alone, press *Calculate alignment*, and get the delay (which side, in ms and metres/feet) and polarity that make them add up best through the crossover. It shows summation before and after, the gain at the crossover, warnings about remaining cancellations, the predicted sum and whether the phase tracks. The predicted sum can be stored as a trace.
- **Sessions:** *Tools → Session & report* saves everything for a job (traces, sweep, EQ, alignment, calibration, measurement setup, name, venue and notes) in one file, to continue later or on another computer.
- **Reports:** *Create report* builds a clean printable report (print, save as PDF or download as HTML) with the setup, spectrum and transfer function against the target (RMS deviation and share within tolerance), sweep response and RT60 table, EQ filters, alignment and notes.
- Tabs: Align is tab 7; the SPL meter and Tools move to 8 and 9.

## What's new in 1.6.1

- **Average curve moved to the Spectrum:** the averaged curve for tuning is now a white line over the live RTA on the Spectrum tab (Average: 1 s, 3 s, 10 s, 30 s or everything since Restart; works with lines and bars). Hover to read it next to the live level. The spectrogram is back to its original layout (frequency up the side); frequency across remains an option under Layout.

## What's new in 1.6

- **Average curve on the spectrogram:** a white averaged-spectrum line across the spectrogram shows the long-term tonal balance while you tune (Average: 1 s, 3 s, 10 s, 30 s or everything since Reset). Hover to read its level at any frequency.
- **Spectrogram layout:** frequency now runs across (newest data at the top, like a waterfall), so the average curve lies horizontally like a spectrum. The previous layout (frequency up the side) is one click away under Layout.
- **Fix:** RTA traces captured with a calibrated microphone now show at the right level in dB SPL (they appeared ~100 dB too low next to the live curve).

## What's new in 1.5

- **Faster everywhere:** a new FFT (1.5–1.8× faster, and 2.7–3.2× for the spectrum's real-valued signals), results and graphs recomputed only when new data arrives, fewer screen updates for numbers that change every frame, and a lighter spectrogram. On the measurement computer the processing load dropped by roughly a third to more than half depending on the tab; on a slow phone the spectrum went from 36 to 54 frames per second.
- **Security:** the remote-access PIN protection now really locks out an address after 8 wrong PINs; the server refuses connections from other websites and unknown host names, and malformed addresses can no longer crash it.
- **Fixes:** remote devices no longer rebuild the generator controls several times a second while music plays (dropdowns and sliders now work there); Enter on a focused button no longer also starts/stops audio; shortcuts don't act behind open dialogs; a sweep requested from a remote device that the host can't run no longer leaves the remote waiting; long sweeps at very high sample rates are refused with a clear message instead of giving a wrong result; SPL Leq/Lmax reset when the calibration changes; several small leaks fixed (playlist window, database connections).

## What's new in 1.4.2

- **Spectrogram fixed with SPL calibration:** with a calibrated microphone (or on a remote device using the host's calibration) the spectrogram showed a solid beige colour. The colour range now follows the calibration, the Floor/Top fields show dB SPL when calibrated, a new **Auto** button fits the range to the signal, and the range fits itself once when the signal is entirely outside it.
- The spectrogram's colour-scale legend shows the full colour scale again and fits on phone screens.

## What's new in 1.4.1

- **Smoother, more accurate low end:** the longer bass windows now blend into the regular ones over a third of an octave instead of switching at a fixed frequency, so the spectrum and transfer function no longer show small steps at 45, 80, 90 or 160 Hz. The bass windows also update as often as the rest of the analysis, so the low end keeps up with changes (about 40% faster to settle than in 1.4.0).
- **No more low bass right after connecting:** after starting, reconnecting or joining as a remote device, the analysis no longer counts the silence from before the audio began, which could pull the low end down for a few seconds (or permanently with cumulative averaging).

## What's new in 1.4

- **Better low-end resolution:** the spectrum and transfer function use longer analysis windows for the bass. Detail is 0.7 Hz (*High*, the new default) or 0.4 Hz (*Maximum*), instead of 2.9 Hz on the spectrum and 1.5 Hz on the transfer function. Tones 2 Hz apart at 40 Hz now show as two separate peaks. Mids and highs keep their fast response, and the extra processing is too small to measure because the bass windows run on a down-sampled copy of the signal. The bass needs a longer stretch of signal (≈1.4 s or 2.7 s) and reacts more slowly: choose *Standard* in Tools → Display & performance for the fastest bass response.
- The EQ filter export button is now called **Copy filter text**, and the calibration file help describes the supported file types.

## What's new in 1.3

- **Spectrum bars:** show the RTA as 1/1, 1/3, 1/6, 1/12 or 1/24-octave bars (Display → Bars, or **B**). Peak hold shows as a cap on each bar.
- **Much faster on older phones and tablets:** remote devices now let the measurement host do the analysis and only draw the result. On-device analysis is also faster: the transfer function needs half the work, and a device only computes what is on screen. *Auto* graph quality lowers the resolution on devices that can't keep up. Settings are in Tools → Display & performance.
- **Detached windows remember where they were:** a panel detached again opens at its last position and size. The desktop app reopens detached windows when it starts. The new **pin** button keeps a detached window on top of other windows (desktop app; picture-in-picture in Chrome and Edge).
- **Music generator with a playlist:** play MP3, WAV, FLAC, OGG or M4A songs through the generator output. Add or drop files, reorder them, and use repeat or shuffle. Songs are level-matched to the generator level and act as the transfer-function reference. Remote devices can control the playlist and add songs from the phone.

## What's new in 1.2

- **One shared session across devices:** the measurement host now keeps all results. A sweep started on a phone, tablet or the host runs on the host, shows its progress everywhere, and the result appears on every connected device (and on devices that connect later). Traces captured, renamed or deleted on any device appear on all of them. Calibration and channel setup changes on a remote reach the host and every other remote.
- **Spectrum on remote devices fixed:** the graph follows the host's SPL calibration instead of going off-scale (the screen-filling blue area).
- **Zoom and move buttons on every graph** (▲ ▼ − + Fit): always shown on touch screens, on hover with a mouse. *Fit* scales the graph to the data.
- **Fullscreen button** in the top bar (or **F11**).

## What's new in 1.1

- **Spectrum** and **Transfer** tabs, each with its own movable, resizable and detachable panels (graphs, SPL meter, input level meters).
- **Day mode:** a high-contrast light colour scheme for use in direct sunlight (sun/moon button or **T**).
- **Remote access:** Tools → Remote access turns the app into a server. Phones, tablets and other computers on the same network scan the QR code or open the address shown, enter the PIN, and get every tab and meter live, including control of the generator and sweeps.
