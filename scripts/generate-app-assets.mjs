import { mkdir } from "node:fs/promises";
import sharp from "sharp";

await mkdir("assets", { recursive: true });

const logo = await sharp("public/my desk logo.png").trim().png().toBuffer();
const platformLogo = await sharp(logo).resize(760, 760, { fit: "contain" }).png().toBuffer();
const platformCanvas = await sharp({
  create: {
    width: 1024,
    height: 1024,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([{ input: platformLogo, gravity: "centre" }])
  .png()
  .toBuffer();

await sharp(platformCanvas).png().toFile("assets/logo.png");

for (const [file, size] of [
  ["public/apple-touch-icon.png", 180],
  ["public/icon-192.png", 192],
  ["public/icon-512.png", 512],
]) {
  const mark = await sharp(logo).resize(Math.round(size * 0.76), Math.round(size * 0.76), { fit: "contain" }).png().toBuffer();
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: "#000000",
    },
  })
    .composite([{ input: mark, gravity: "centre" }])
    .png()
    .toFile(file);
}
