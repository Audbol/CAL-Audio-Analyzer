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

## What's new in 1.2

- **One shared session across devices:** the measurement host now keeps all results. A sweep started on a phone, tablet or the host runs on the host, shows its progress everywhere, and the result appears on every connected device (and on devices that connect later). Traces captured, renamed or deleted on any device appear on all of them. Calibration and channel setup changes on a remote reach the host and every other remote.
- **Spectrum on remote devices fixed:** the graph follows the host's SPL calibration instead of going off-scale (the screen-filling blue area).
- **Zoom and move buttons on every graph** (▲ ▼ − + Fit): always shown on touch screens, on hover with a mouse. *Fit* scales the graph to the data.
- **Fullscreen button** in the top bar (or **F11**).

## What's new in 1.1

- **Spectrum** and **Transfer** tabs, each with its own movable, resizable and detachable panels (graphs, SPL meter, input level meters).
- **Day mode:** a high-contrast light colour scheme for use in direct sunlight (sun/moon button or **T**).
- **Remote access:** Tools → Remote access turns the app into a server. Phones, tablets and other computers on the same network scan the QR code or open the address shown, enter the PIN, and get every tab and meter live, including control of the generator and sweeps.
