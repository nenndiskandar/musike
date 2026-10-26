import { execFile } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { msg } from "./i18n.js";
import { HttpError, VIDEO_ID } from "./types.js";
import { invalidate, resolveStreams } from "./ytdlp.js";

const exec = promisify(execFile);

/** MP3 downloads live in the cache dir, one per video id. */
const mp3For = (id: string) => path.join(config.cacheDir, "mp3", `${id}.mp3`);

/** Filename shown to the browser: "Artist - Title.mp3". */
export function mp3FileName(title: string, artist: string): string {
  const base = [artist, title]
    .map((s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim())
    .filter(Boolean)
    .join(" - ");
  return `${base || "audio"}.mp3`.slice(0, 120);
}

/** Returns a working ffmpeg binary; system ffmpeg is preferred over the bundled nested build. */
function ffmpegBin(): string {
  return (
    ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(
      (p) => existsSync(p) && !statSync(p).isDirectory(),
    ) ?? "ffmpeg"
  );
}

/** Renders (and caches) the song as an MP3 download. */
export async function downloadMp3(id: string, title: string, artist: string): Promise<string> {
  if (!VIDEO_ID.test(id)) throw new HttpError(400, msg("invalidVideoId"));
  const bin = ffmpegBin();

  const file = mp3For(id);
  if (existsSync(file)) return file;

  const tmp = `${file}.part.mp3`; // .mp3 suffix so ffmpeg accepts the output filename
  await mkdir(path.dirname(tmp), { recursive: true });
  const raw = `${file}.raw.m4a`;

  try {
    // Step 1: fetch audio into a local temp file (no URL expiry / quoting issues).
    const attempt = async () => {
      const resolved = await resolveStreams(id);
      const res = await fetch(resolved.audio.url, { headers: resolved.audio.headers });
      if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 4096) throw new Error(`audio buffer too small (${buf.length}B)`);
      await writeFile(raw, buf);

      // Step 2: ffmpeg re-encodes as MP3 with embedded ID3 metadata.
      await exec(bin, [
        "-y",
        "-i", raw,
        "-vn",
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        "-ar", "44100",
        "-ac", "2",
        "-metadata", `title=${title || resolved.title || id}`,
        ...(artist ? ["-metadata", `artist=${artist}`] : []),
        "-id3v2_version", "3",
        "-write_id3v1", "1",
        tmp,
      ], { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 * 16 });
    };

    try {
      await attempt();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // Stale URL: invalidate cache and retry once.
      invalidate(id);
      await attempt();
    }

    const size = await stat(tmp).then((s) => s.size, () => 0);
    if (size < 1024) throw new Error("mp3 output too small");
    await rename(tmp, file);
    return file;
  } catch (err) {
    await rm(tmp, { force: true });
    if (err instanceof HttpError) throw err;
    console.error(`[mp3] render failed for ${id}: ${(err as Error).message.slice(0, 300)}`);
    throw new HttpError(502, msg("mp3Failed"));
  } finally {
    await rm(raw, { force: true });
  }
}

/** Sends the MP3 with a friendly filename and byte-range support. */
export async function serveMp3(
  req: FastifyRequest,
  reply: FastifyReply,
  id: string,
  track?: { title?: string; artist?: string },
) {
  if (!VIDEO_ID.test(id)) throw new HttpError(400, msg("invalidVideoId"));
  const file = await downloadMp3(id, track?.title || "", track?.artist || "");
  const resolved = await resolveStreams(id).catch(() => null);
  const name = mp3FileName(track?.title || resolved?.title || id, track?.artist || "");
  const { size } = await stat(file);

  const range = typeof req.headers.range === "string" ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
  reply.header("content-type", "audio/mpeg");
  reply.header("accept-ranges", "bytes");
  reply.header("cache-control", "private, max-age=3600");
  reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);

  if (!range) {
    reply.header("content-length", size);
    return reply.send(createReadStream(file));
  }

  let start = range[1] ? Number(range[1]) : NaN;
  let end = range[2] ? Number(range[2]) : size - 1;
  if (Number.isNaN(start)) {
    start = Math.max(0, size - end);
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start > end || start >= size) {
    reply.code(416).header("content-range", `bytes */${size}`);
    return reply.send();
  }

  reply.code(206);
  reply.header("content-range", `bytes ${start}-${end}/${size}`);
  reply.header("content-length", end - start + 1);
  return reply.send(createReadStream(file, { start, end }));
}
