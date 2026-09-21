import { replaceVideo } from "../video-replacement.js";
import { withBiliCookie } from "../sources.js";
import { downloadVideo } from "../media.js";
import { refreshVideo } from "./refresh-video.js";
import { biliCookie } from "../bili-credentials.js";

export async function attach(job, payload, context) {
  if (job.kind === "attach-video")
    return refreshVideo(
      job,
      { ...payload, clip: null, quality: "highest" },
      context,
    );
  const {
    db,
    get,
    set,
    store,
    dir,
    roots,
    downloads,
    cache,
    legacyCache,
    emit,
    addJob,
    enqueue,
    fail,
  } = context;
  {
    const song = db.prepare("SELECT * FROM songs WHERE id=?").get(payload.id);
    if (!song) throw fail(404, "歌曲不存在");
    if (db.prepare("SELECT id FROM queue WHERE song_id=?").get(song.id))
      throw fail(409, "请先移出播放队列");
    const { file } = await withBiliCookie(
      biliCookie(store),
      dir,
      (file) => downloadVideo(payload.url, downloads, file),
    );
    const replacement = await replaceVideo(
      store,
      song,
      file,
      payload.url,
      cache,
      { confirmed: payload.confirmed, offset: payload.offset },
    );
    if (!replacement.keepAudio) addJob("organize", { id: song.id });
  }
}
