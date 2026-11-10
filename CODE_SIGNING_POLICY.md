# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What is signed

Only the Windows installer of Vozella (`Vozella-Setup-<version>.exe`) and the Vozella executables it installs are signed. They are built from the source code in this repository by the [Release workflow](.github/workflows/release.yml) on GitHub Actions. Nothing built outside that workflow is signed.

Third-party binaries that Vozella downloads at run time are not signed by this project. They are fetched from their own publishers' official releases:

- [llama.cpp](https://github.com/ggml-org/llama.cpp) runtime, for local summaries
- [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) runtime, for local transcription
- [yt-dlp](https://github.com/yt-dlp/yt-dlp), for importing YouTube videos

## Team roles

Vozella is maintained by a single person, who holds every role.

| Role | Members |
| --- | --- |
| Committers and reviewers | [Andres Torres](https://github.com/andrest04) |
| Approvers | [Andres Torres](https://github.com/andrest04) |

- **Committers** may change the source code without further review.
- **Reviewers** review every change from anyone outside the committers, such as a pull request, before it is merged.
- **Approvers** manually approve every signing request before a release is signed.

All team members use multi-factor authentication for GitHub and SignPath.

## Privacy policy

Vozella records, transcribes and summarizes meetings on your computer. Your recordings, transcripts and notes stay on your device. Vozella has no telemetry and no analytics, and the Vozella project runs no server that receives your data.

The program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. Network access happens only in these cases:

- **Model and runtime downloads.** When you choose a local transcription or summary model, Vozella downloads the model from [Hugging Face](https://huggingface.co/privacy) and its runtime from GitHub (see the list above). No recording or transcript is sent.
- **Cloud AI providers you configure.** If you add your own API key for OpenAI, Anthropic or Google Gemini, or connect a command-line tool such as Claude Code or Codex, the transcript text needed for a summary or chat answer is sent to that provider. Their privacy policies apply:
  [OpenAI](https://openai.com/policies/privacy-policy),
  [Anthropic](https://www.anthropic.com/legal/privacy),
  [Google](https://policies.google.com/privacy).
- **YouTube import.** When you import a YouTube video, Vozella downloads it from YouTube with yt-dlp. [Google's privacy policy](https://policies.google.com/privacy) applies.

Cloud providers are off until you configure them, and you can remove them at any time in Settings.

## Uninstalling

Vozella can be removed from **Settings > Apps > Installed apps** in Windows, or with the uninstaller in its installation folder. Your recordings and notes are kept unless you delete them yourself.
