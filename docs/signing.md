# Signing the desktop builds

Unsigned builds work, but Windows shows "Windows protected your PC" and macOS says the app "is damaged" or "can't
be opened" until it is allowed by hand. Signed builds open without these warnings, and the macOS build can update
itself (macOS only installs updates for signed apps).

The release workflow (`.github/workflows/desktop.yml`) signs automatically as soon as the secrets below exist.
Without them it builds unsigned, as before. Add them under **Settings → Secrets and variables → Actions** in the
GitHub repository.

## macOS: Developer ID and notarization

You need a membership of the [Apple Developer Program](https://developer.apple.com/programs/) (yearly fee).

1. In your Apple developer account, create a **Developer ID Application** certificate and install it in the
   Keychain of a Mac.
2. In Keychain Access, export the certificate with its private key as a `.p12` file and choose a password.
3. Encode the file: `base64 -i certificate.p12 | pbcopy` (copies it to the clipboard).
4. At [appleid.apple.com](https://appleid.apple.com), create an **app-specific password** for notarization.
5. Add these repository secrets:

| Secret | Value |
| --- | --- |
| `MAC_CERT_P12_BASE64` | The base64 text from step 3 |
| `MAC_CERT_PASSWORD` | The password of the `.p12` file |
| `APPLE_ID` | Your Apple ID (email) |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password from step 4 |
| `APPLE_TEAM_ID` | Your 10-character team ID (Membership details in the developer account) |

With these, the macOS builds are signed with the hardened runtime (entitlements in
`build/entitlements.mac.plist`: audio input and what Electron needs) and notarized by Apple.

## Windows: a certificate file or Azure Trusted Signing

**Option A: a code-signing certificate file.** If your certificate authority gives you a `.pfx` file:

| Secret | Value |
| --- | --- |
| `WIN_CERT_PFX_BASE64` | The `.pfx` file, base64-encoded (`base64 -w0 certificate.pfx` on Linux, `[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx"))` in PowerShell) |
| `WIN_CERT_PASSWORD` | Its password |

Most certificates issued today live on a hardware token or in a cloud service and can't be exported as a file. Then
use option B.

**Option B: [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)** (a monthly fee, no
hardware). Create a Trusted Signing account and a certificate profile, and an app registration that may sign with it.
Then add:

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` | Directory (tenant) ID of the app registration |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | A client secret of the app registration |

and these repository **variables** (the Variables tab next to Secrets):

| Variable | Value |
| --- | --- |
| `AZURE_SIGN_ENDPOINT` | The account's endpoint, e.g. `https://weu.codesigning.azure.net/` |
| `AZURE_SIGN_ACCOUNT` | The Trusted Signing account name |
| `AZURE_SIGN_PROFILE` | The certificate profile name |
| `AZURE_SIGN_PUBLISHER` | The publisher name exactly as in the certificate (your name or company) |

## Checking

Run the workflow (Actions → Desktop app → Run workflow). The "Build desktop app" step prints "Signing for macOS and
notarizing" or "Signing for Windows …" when the secrets are found. Linux AppImages are not signed.
