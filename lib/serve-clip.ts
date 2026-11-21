// Streams a stored clip from R2, honouring Range (browsers seek; Instagram may fetch in parts). `contentType` for
// files that aren't MP4 (split-screen background images).
export async function serveClip(bucket: R2Bucket, key: string, request: Request, { cache, filename, contentType = "video/mp4" }: { cache: string; filename?: string; contentType?: string }) {
  const object = await bucket.get(key, { range: request.headers, onlyIf: request.headers });
  if (!object) return new Response("Clip file not found.", { status: 404 });
  const headers = new Headers({ "Content-Type": contentType, "Accept-Ranges": "bytes", "Cache-Control": cache, "ETag": object.httpEtag });
  if (filename) headers.set("Content-Disposition", `attachment; filename="${filename}"`);
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  const range = object.range as { offset: number; length: number } | undefined;
  if (range && request.headers.has("range")) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    headers.set("Content-Length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}
