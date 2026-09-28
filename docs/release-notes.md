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
