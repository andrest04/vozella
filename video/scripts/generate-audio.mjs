// Generates the soundtrack and sound effects for the presentation video with ElevenLabs.
//
//   npm run audio            generate the files that are missing
//   npm run audio -- --force regenerate everything
//
// The SDK reads ELEVENLABS_API_KEY from the environment; the npm script loads it from the
// repo's .env.local. Output goes to assets/audio/, which index.html references.
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "audio");
const force = process.argv.includes("--force");

// The video is 50 s: a tense typographic hook (0 to 4 s), the logo reveal at 4 s, eight
// product scenes, and a final lockup from 45.4 s.
const MUSIC = {
  file: "music.mp3",
  prompt:
    "Cinematic minimal electronic score for a product film, instrumental. " +
    "Opens sparse and tense for four seconds with a low pulse and filtered noise, " +
    "then a confident hit and a steady driving groove around 110 BPM: deep sub bass, " +
    "tight punchy drums, plucked analog synth arpeggio, wide warm pads. " +
    "Builds in intensity through the middle, peaks near the end, " +
    "and resolves on one sustained final chord with a clean tail. " +
    "Modern, precise, dark, restrained. No vocals.",
  lengthMs: 50000,
};

const EFFECTS = [
  {
    file: "riser.mp3",
    text: "Cinematic tension riser, dark synth swell with rising filtered noise, builds steadily and cuts off abruptly at the peak",
    durationSeconds: 4,
  },
  {
    file: "impact.mp3",
    text: "Deep cinematic impact, tight sub boom with a short metallic click transient and a clean dark tail, no reverb wash",
    durationSeconds: 2.5,
  },
  {
    file: "whoosh.mp3",
    text: "Fast clean whoosh transition, airy swish passing downwards, ending in a soft thump",
    durationSeconds: 1.2,
  },
];

const client = new ElevenLabsClient();

async function save(audio, file) {
  // Depending on the endpoint the SDK returns a Node stream or a web ReadableStream.
  const source = typeof audio.getReader === "function" ? Readable.fromWeb(audio) : audio;
  await pipeline(source, createWriteStream(join(OUT_DIR, file)));
  console.log(`wrote assets/audio/${file}`);
}

function wanted(file) {
  if (force || !existsSync(join(OUT_DIR, file))) return true;
  console.log(`kept  assets/audio/${file} (use --force to regenerate)`);
  return false;
}

mkdirSync(OUT_DIR, { recursive: true });

if (wanted(MUSIC.file)) {
  const audio = await client.music.compose({
    prompt: MUSIC.prompt,
    musicLengthMs: MUSIC.lengthMs,
    forceInstrumental: true,
    modelId: "music_v2_5",
  });
  await save(audio, MUSIC.file);
}

for (const effect of EFFECTS) {
  if (!wanted(effect.file)) continue;
  const audio = await client.textToSoundEffects.convert({
    text: effect.text,
    modelId: "eleven_text_to_sound_v3",
    durationSeconds: effect.durationSeconds,
    promptInfluence: 0.6,
  });
  await save(audio, effect.file);
}
