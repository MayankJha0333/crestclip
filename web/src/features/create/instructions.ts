/** Every link in the box (one per line, or separated by spaces/commas). */
export const splitLinks = (text: string) =>
  [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter((x) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+\//i.test(x)),
    ),
  ].map((x) => (/^https?:\/\//i.test(x) ? x : `https://${x}`));

const VIDEO_LINK =
  /(youtube\.com|youtu\.be|drive\.google\.com\/file|docs\.google\.com\/file|dropbox\.com|1drv\.ms|onedrive\.live\.com|sharepoint\.com|twitch\.tv|vimeo\.com|\.(mp4|mov|mkv|webm)(\?|$))/i;

/** A quick preview of how the instructions will be read (the server reads them properly with Gemini). */
export function previewInstructions(t: string) {
  const range = t.match(/(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})\s*(?:s\b|sec|seconds)/i);
  const max = t.match(/(?:max(?:imum)?|under|less than|no longer than|up to)\s*(\d{1,3})\s*(?:s\b|sec|seconds)/i);
  const tags = [...new Set([...(t.match(/(?:^|\s)@[\w.]{2,30}/g) ?? []).map((x) => x.trim().replace(/\.+$/, '')), ...(t.match(/#[\p{L}\p{N}_]{2,40}/gu) ?? [])])];
  const links = [...new Set((t.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).filter((u) => VIDEO_LINK.test(u)).map((u) => u.replace(/[.,;:!?]+$/, '')))];
  return { length: range ? `${range[1]}–${range[2]}s` : max ? `up to ${max[1]}s` : null, tags: tags.slice(0, 8), links };
}

export const fmtBytes = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.max(0.1, b / 1024 ** 2).toFixed(b < 1024 ** 2 * 10 ? 1 : 0)} MB`);
