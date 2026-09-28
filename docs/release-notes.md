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
