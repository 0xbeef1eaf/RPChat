# App icons

`icon-source.png` is the master artwork, as supplied. Everything else here is a downscale of it, so
changing the icon means replacing that one file and regenerating the rest — never edit a derived size
by hand, and never upscale a small one to fill a larger slot (the previous artwork was a 4x upscale of
a 128x128 original, which bought no detail and carried the source's scanline artefacts into every
size).

| File | Size | Used by |
| --- | --- | --- |
| `icon-source.png` | master | nothing at build time; the source the others come from |
| `icon.png` | 512 | electron-builder (`build.linux.icon`; win/mac derive `.ico`/`.icns` from it) |
| `icon-128.png` … `icon-32.png` | 128, 64, 48, 32 | `native/rpchatd/install.sh`, one per `hicolor` size directory |
| `../resources/tray.png` | 32 | the tray icon (`src/main/index.ts`, resized to 22 at runtime) |

`install.sh` needs the small sizes because `/usr/local/share/icons/hicolor` has no `index.theme` of
its own: a launcher that cannot read the hicolor `Directories` list probes a hard-coded set of size
directories instead, and several stop at 256x256, so a 512-only icon never resolves. See
`docs/system-integration.md` step 6.

## Regenerating

Any tool is fine as long as the sizes and filenames match the table. With Pillow:

```python
from PIL import Image
master = Image.open('icon-source.png').convert('RGBA')
for path, size in [('icon.png', 512), ('icon-128.png', 128), ('icon-64.png', 64),
                   ('icon-48.png', 48), ('icon-32.png', 32), ('../resources/tray.png', 32)]:
    master.resize((size, size), Image.LANCZOS).save(path, 'PNG', optimize=True)
```

Keep the master fully opaque, or at least free of fully transparent edge rows and columns: a
transparent edge bleeds into the downscales as a faint translucent border.
