// show a random portrait of Makima for five seconds and return its path
async () => {
  const portraits = await sdk.pack.findAssets({ tags: ["portrait"], kind: "image" });
  if (portraits.length === 0) return null;
  const pick = portraits[Math.floor(Math.random() * portraits.length)];
  await sdk.media.showImage(pick, { durationMs: 5000, position: "bottom-right" });
  return pick.path;
}
