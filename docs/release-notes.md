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

## What's new in 1.1

- **Spectrum** and **Transfer** tabs, each with its own movable, resizable and detachable panels (graphs, SPL meter, input level meters).
- **Day mode:** a high-contrast light colour scheme for use in direct sunlight (sun/moon button or **T**).
- **Remote access:** Tools → Remote access turns the app into a server. Phones, tablets and other computers on the same network scan the QR code or open the address shown, enter the PIN, and get every tab and meter live, including control of the generator and sweeps.
