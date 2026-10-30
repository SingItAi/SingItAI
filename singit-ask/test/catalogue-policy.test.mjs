import { test } from "node:test";
import assert from "node:assert/strict";
import { parseImageModels, parseVoiceModels, parseVideoModels } from "../src/catalogue.mjs";

for (const [kind, parse, fields] of [
  ["image", parseImageModels, { metering: "per_image", architecture: { modality: "text->image" }, pricing: { image: "0.01" } }],
  ["speech", (data) => parseVoiceModels(data).speech, { architecture: { modality: "text->audio" }, pricing: { image: "0.01", media_unit: "1K characters" } }],
  ["transcription", (data) => parseVoiceModels(data).transcription, { architecture: { modality: "audio->text" }, pricing: { image: "0.01", media_unit: "minute" } }],
  ["video", parseVideoModels, { architecture: { modality: "video" }, pricing: { image: "0.01", media_unit: "job" }, supported_parameters: ["text-to-video"] }],
]) {
  test(`${kind} catalogue allows uncensored/nsfw/lustify and excludes edit/remover/upscale IDs`, () => {
    const allowed = ["ordinary", "UnCeNsOrEd", "NSFW", "lustify"];
    const excluded = ["model-EdIt", "background-ReMoVeR", "model-UpScAlE"];
    const models = parse({ data: [...allowed, ...excluded].map((id) => ({ id, ...fields })) });
    assert.deepEqual([...models.keys()], allowed);
  });
}
