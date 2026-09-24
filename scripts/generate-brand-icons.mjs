import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const svg = await readFile(resolve(root, "public/brand-icon.svg"), "utf8");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const render = async (size) => {
    const png = await page.evaluate(async ({ svg, size }) => {
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${btoa(svg)}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      canvas.getContext("2d").drawImage(image, 0, 0, size, size);
      return canvas.toDataURL("image/png").split(",")[1];
    }, { svg, size });
    return Buffer.from(png, "base64");
  };
  for (const [name, size] of [
    ["favicon.png", 300],
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
  ]) {
    await writeFile(resolve(root, "public", name), await render(size));
  }
  const sizes = [16, 32, 48, 64];
  const pngs = await Promise.all(sizes.map(render));
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  for (let index = 0; index < sizes.length; index++) {
    const entry = 6 + index * 16;
    directory.writeUInt8(sizes[index], entry);
    directory.writeUInt8(sizes[index], entry + 1);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(pngs[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += pngs[index].length;
  }
  await writeFile(resolve(root, "public/favicon.ico"), Buffer.concat([directory, ...pngs]));
} finally {
  await browser.close();
}
