package home.haohaochang.tv;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Network/state coordinator, separate from views and the Media3 audio clock. */
final class RoomSession implements AutoCloseable {
  interface Listener {
    void state(JSONObject state);

    void media(String entry, JSONObject resources, boolean legacy);

    void lyrics(String entry, LyricsTimeline lyrics, JSONObject style, double offset);

    void permission(boolean allowed);

    void error(String message, boolean auth);
  }

  interface Result {
    void success(Object value);
  }

  final RoomApi api;
  String deviceType = "tv";
  final String playerId = "tv-" + UUID.randomUUID();
  final String micKey = UUID.randomUUID().toString().replace("-", "");
  private final Listener listener;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService reads = Executors.newFixedThreadPool(2),
      controls = Executors.newSingleThreadExecutor(),
      beats = Executors.newSingleThreadExecutor();
  private boolean closed, active = true, polling, beating, claiming = true, owned, revoked;
  private long lastBeat, ownerRevision = -1, mutation;
  private int mediaGeneration, pendingCommands;
  private String entry = "";

  RoomSession(RoomApi api, Listener listener) {
    this.api = api;
    this.listener = listener;
  }

  void start() {
    heartbeat();
    poll();
    main.post(tick);
  }

  private final Runnable tick =
      new Runnable() {
        public void run() {
          if (closed) return;
          if (active) {
            if (lastBeat > 0 && SystemClock.elapsedRealtime() - lastBeat > 10000)
              listener.permission(false);
            if (!beating && (lastBeat == 0 || SystemClock.elapsedRealtime() - lastBeat >= 5000))
              heartbeat();
            poll();
          }
          main.postDelayed(this, 1000);
        }
      };

  private void heartbeat() {
    if (closed || !active || beating || revoked) return;
    beating = true;
    JSONObject body = RoomApi.object(
        "id", playerId, "type", deviceType, "claim", claiming, "micKey", micKey);
    beats.execute(
        () -> {
          try {
            long sentAt = SystemClock.elapsedRealtime();
            JSONObject result = (JSONObject) api.json("/api/player/heartbeat", body);
            main.post(
                () -> {
                  if (closed) return;
                  beating = false;
                  if (!active || revoked) return;
                  if (SystemClock.elapsedRealtime() - sentAt >= 10000) {
                    listener.permission(false);
                    return;
                  }
                  JSONObject owner = result.optJSONObject("owner");
                  if (owner != null && owner.optLong("revision") < ownerRevision) return;
                  ownerRevision = owner == null ? ownerRevision : owner.optLong("revision");
                  owned = true;
                  claiming = false;
                  lastBeat = sentAt;
                  listener.permission(true);
                });
          } catch (Exception error) {
            main.post(
                () -> {
                  if (closed) return;
                  beating = false;
                  if (error instanceof RoomApi.Failure) {
                    String code = ((RoomApi.Failure) error).code;
                    if (code.equals("PLAYER_REPLACED")) revoked = true;
                    if (code.equals("PLAYER_BUSY")) claiming = false;
                  }
                  connectionFailure(error);
                });
          }
        });
  }

  private void connectionFailure(Exception error) {
    boolean rejected = error instanceof RoomApi.Failure && ((RoomApi.Failure) error).status < 500 && ((RoomApi.Failure) error).status != 429;
    if (rejected || revoked || !active || lastBeat == 0 || SystemClock.elapsedRealtime() - lastBeat >= 10000) {
      listener.permission(false);
      listener.error(message(error), auth(error));
    }
  }

  private void poll() {
    if (closed || !active || polling || pendingCommands > 0) return;
    polling = true;
    long epoch = mutation;
    reads.execute(
        () -> {
          try {
            JSONObject state = (JSONObject) api.json("/api/state", null);
            main.post(
                () -> {
                  if (closed) return;
                  polling = false;
                  if (active && epoch == mutation) accept(state);
                });
          } catch (Exception error) {
            main.post(
                () -> {
                  if (closed) return;
                  polling = false;
                  connectionFailure(error);
                });
          }
        });
  }

  private void accept(JSONObject state) {
    JSONObject owner = state.optJSONObject("player");
    if (owner != null && owner.optLong("revision") >= ownerRevision) {
      ownerRevision = owner.optLong("revision");
      if (owned && !owner.optString("id").equals(playerId)) {
        revoked = true;
        listener.permission(false);
        listener.error("另一台电视已接管播放，可继续点歌；重新连接可接管。", false);
      }
    }
    listener.state(state);
    JSONArray queue = state.optJSONArray("queue");
    JSONObject current =
        queue != null && queue.length() > 0
            ? queue.optJSONObject(0)
            : state.optJSONObject("ambient");
    String next = current == null ? "" : current.optString("id");
    if (!entry.equals(next)) {
      entry = next;
      mediaGeneration++;
      if (current != null) loadMedia(current, mediaGeneration);
    }
  }

  void retry(JSONObject current) {
    if (current != null) loadMedia(current, ++mediaGeneration);
  }

  private void loadMedia(JSONObject current, int generation) {
    String id = current.optString("id"), song = current.optString("song_id");
    reads.execute(
        () -> {
          try {
            JSONObject manifest =
                (JSONObject) api.json("/api/playback-assets/" + RoomApi.encode(song), null);
            JSONObject all = manifest.optJSONObject("resources"), resources = new JSONObject();
            for (String kind : new String[] {"video", "vocal", "backing"}) {
              JSONObject item = all == null ? null : all.optJSONObject(kind);
              if (item != null && item.optBoolean("available")) {
                JSONObject normalized = new JSONObject(item.toString());
                String url = api.absolute(item.getString("url"));
                normalized.put(
                    "url",
                    url + (url.contains("?") ? "&" : "?") + "token=" + RoomApi.encode(api.token));
                resources.put(kind, normalized);
              }
            }
            boolean legacy = manifest.optInt("version") == 1;
            main.post(
                () -> {
                  if (!closed && generation == mediaGeneration)
                    listener.media(id, resources, legacy);
                });
            String text = current.optString("lyrics");
            double offset = 0;
            JSONObject lyric = all == null ? null : all.optJSONObject("lyrics");
            if (!legacy && lyric != null && lyric.optBoolean("available")) {
              offset = lyric.optDouble("offset", 0);
              try {
                text =
                    new String(
                        api.bytes(lyric.getString("url"), "GET", null, 1024 * 1024),
                        StandardCharsets.UTF_8);
              } catch (Exception ignored) {
                /* Inline LRC remains a usable fallback. */
              }
            }
            JSONObject style = new JSONObject();
            try {
              style = (JSONObject) api.json("/api/lyrics-style", null);
            } catch (Exception ignored) {
            }
            LyricsTimeline timeline = new LyricsTimeline(text);
            JSONObject finalStyle = style;
            double finalOffset = offset;
            main.post(
                () -> {
                  if (!closed && generation == mediaGeneration)
                    listener.lyrics(id, timeline, finalStyle, finalOffset);
                });
          } catch (Exception error) {
            main.post(
                () -> {
                  if (!closed && generation == mediaGeneration)
                    listener.error(message(error), auth(error));
                });
          }
        });
  }

  void command(String path, String method, JSONObject body, Result result) {
    if (closed) return;
    // Invalidate a state GET that started before this control command.
    mutation++;
    pendingCommands++;
    controls.execute(
        () -> {
          try {
            Object value = api.json(path, method, body);
            main.post(
                () -> {
                  if (closed) return;
                  mutation++;
                  pendingCommands--;
                  if (value instanceof JSONObject && ((JSONObject) value).has("queue"))
                    accept((JSONObject) value);
                  if (result != null) result.success(value);
                });
          } catch (Exception error) {
            main.post(
                () -> {
                  if (!closed) {
                    pendingCommands--;
                    listener.error(message(error), auth(error));
                  }
                });
          }
        });
  }

  void read(String path, Result result) {
    read(path, result, false);
  }

  void read(String path, Result result, boolean quiet) {
    if (closed) return;
    reads.execute(
        () -> {
          try {
            Object value = api.json(path, null);
            main.post(
                () -> {
                  if (!closed) result.success(value);
                });
          } catch (Exception error) {
            main.post(
                () -> {
                  if (!closed) {
                    if (quiet) result.success(null);
                    else listener.error(message(error), auth(error));
                  }
                });
          }
        });
  }

  void active(boolean value) {
    active = value;
    listener.permission(false);
    if (value) {
      lastBeat = 0;
      heartbeat();
      poll();
    }
  }

  static String message(Exception error) {
    return error instanceof RoomApi.Failure ? error.getMessage() : "连接 NAS 失败，请检查网络后重试";
  }

  static boolean auth(Exception error) {
    return error instanceof RoomApi.Failure && ((RoomApi.Failure) error).status == 401;
  }

  @Override
  public void close() {
    closed = true;
    mediaGeneration++;
    main.removeCallbacksAndMessages(null);
    listener.permission(false);
    api.close();
    reads.shutdownNow();
    controls.shutdownNow();
    beats.shutdownNow();
  }
}
