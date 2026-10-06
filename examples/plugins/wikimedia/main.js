// Example rpchat plugin: a remote media source over Wikimedia Commons. Plain ESM, no dependencies.
// Loaded by the app's main process; `activate(host)` returns one provider per media source the
// manifest declares. Characters reach it as `dev.rpchat.wikimedia/commons` through sdk.mediaSources.

const API = 'https://commons.wikimedia.org/w/api.php';
/** Commons asks every client to say who it is. */
const USER_AGENT = 'rpchat-wikimedia-example/1.0 (https://github.com/rpchat)';
/** Wide enough for an overlay, small enough to download in a moment. */
const WIDTH = 1280;
/** Formats the media pages can show (a thumbnail of anything else comes back as one of these). */
const SHOWABLE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * @param {import('@rp/shared').PluginHost} host
 * @returns {Promise<import('@rp/shared').PluginActivation>}
 */
export async function activate(host) {
  /** One Commons API call; the answer's `query.pages`, or an empty object when nothing matched. */
  async function query(params) {
    const url = `${API}?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params })}`;
    const res = await host.fetch(url, { headers: { 'user-agent': USER_AGENT }, timeoutMs: 15_000 });
    if (res.status !== 200) throw new Error(`Wikimedia Commons answered HTTP ${res.status}`);
    return JSON.parse(res.text).query?.pages ?? [];
  }

  /** Plain text of an extmetadata field (Commons gives HTML). */
  function text(field) {
    return (field?.value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return {
    handlers: {},
    mediaSources: {
      commons: {
        /** @param {import('@rp/shared').MediaSourceQuery} q */
        async search(q) {
          const words = [q.text, ...(q.tags ?? [])].filter(Boolean).join(' ');
          if (!words) return [];
          const limit = q.limit ?? 20;
          const pages = await query({
            generator: 'search',
            gsrsearch: `${words} filetype:bitmap`,
            gsrnamespace: '6',
            gsrlimit: String(limit),
            gsroffset: String(((q.page ?? 1) - 1) * limit),
            prop: 'imageinfo',
            iiprop: 'mime|size|extmetadata',
            iiextmetadatafilter: 'ImageDescription|ObjectName|Categories',
          });
          return pages
            .filter((p) => SHOWABLE.has(p.imageinfo?.[0]?.mime))
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map((p) => {
              const info = p.imageinfo[0];
              const description = text(info.extmetadata?.ImageDescription) || text(info.extmetadata?.ObjectName) || p.title.replace(/^File:/, '');
              const tags = text(info.extmetadata?.Categories).split('|').map((t) => t.trim().toLowerCase()).filter((t) => t && t.length < 40).slice(0, 8);
              // The page id is stable; fetch() asks for a fresh thumbnail URL when the item is shown.
              return { id: String(p.pageid), kind: 'image', mime: info.mime, description: description.slice(0, 200), tags };
            });
        },

        async fetch(itemId) {
          const [page] = await query({ pageids: itemId, prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: String(WIDTH) });
          const info = page?.imageinfo?.[0];
          if (!info) throw new Error(`Commons has no file with page id ${itemId}`);
          return { url: info.thumburl ?? info.url, headers: { 'user-agent': USER_AGENT } };
        },
      },
    },
  };
}
