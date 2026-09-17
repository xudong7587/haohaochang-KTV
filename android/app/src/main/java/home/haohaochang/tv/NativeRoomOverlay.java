package home.haohaochang.tv;

import android.content.Context;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

/** Static QR and a brief queue reminder. Never updated by the playback frame loop. */
final class NativeRoomOverlay extends LinearLayout implements AutoCloseable {
  private final RoomSession session;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ImageView qr;
  private final LinearLayout queuePanel, code;
  private JSONArray queue = new JSONArray();
  private String queueKey = "";
  private boolean full, closed, loading, loaded;
  private final Runnable hideQueue = () -> queuePanelVisibility(false);
  private final Runnable cycle =
      new Runnable() {
        public void run() {
          if (!full || closed) return;
          loadQr();
          showQueue();
          handler.postDelayed(this, 30000);
        }
      };

  NativeRoomOverlay(Context context, RoomSession session) {
    super(context);
    this.session = session;
    setOrientation(VERTICAL);
    setGravity(Gravity.RIGHT);
    setFocusable(false);
    setContentDescription("扫码点歌与已点歌单");
    code = new LinearLayout(context);
    code.setOrientation(VERTICAL);
    code.setGravity(Gravity.CENTER);
    code.setPadding(dp(8), dp(8), dp(8), dp(6));
    code.setBackground(TvStyle.surface(context, 0xf532283f, 0xf21d1826, 12, 0x22eadcff));
    code.setElevation(dp(3));
    addView(code, new LayoutParams(dp(112), -2));
    qr = new ImageView(context);
    qr.setContentDescription("手机扫码点歌二维码");
    qr.setBackgroundColor(android.graphics.Color.WHITE);
    code.addView(qr, new LayoutParams(dp(96), dp(96)));
    TextView label = TvStyle.text(context, "手机扫码点歌", 10, TvStyle.INK);
    label.setGravity(Gravity.CENTER);
    code.addView(label, new LayoutParams(-1, dp(24)));
    queuePanel = new LinearLayout(context);
    queuePanel.setOrientation(VERTICAL);
    queuePanel.setPadding(dp(12), dp(9), dp(12), dp(9));
    queuePanel.setBackground(TvStyle.surface(context, 0xee362a45, 0xee211a2c, 12, 0x20eadcff));
    queuePanel.setElevation(dp(3));
    queuePanel.setContentDescription("全屏已点歌单");
    LayoutParams list = new LayoutParams(dp(176), -2);
    list.topMargin = dp(10);
    addView(queuePanel, list);
    setVisibility(GONE);
  }

  private int dp(float value) {
    return TvStyle.dp(getContext(), value);
  }

  void fullscreen(boolean value) {
    setVisibility(VISIBLE);
    code.setLayoutParams(new LayoutParams(value ? dp(112) : -1, -2));
    qr.setLayoutParams(new LayoutParams(dp(value ? 96 : 72), dp(value ? 96 : 72)));
    code.setPadding(dp(8), dp(value ? 8 : 4), dp(8), dp(value ? 6 : 2));
    loadQr();
    if (full == value) {
      if (!full) queuePanel.setVisibility(GONE);
      return;
    }
    full = value;
    if (!full) queuePanel.setVisibility(GONE);
    handler.removeCallbacks(cycle);
    handler.removeCallbacks(hideQueue);
    if (full) {
      loadQr();
      cycle.run();
    }
  }

  private void loadQr() {
    if (loaded || loading || closed) return;
    loading = true;
    handler.postDelayed(
        () -> {
          loading = false;
          if (!loaded && !closed) loadQr();
        },
        15000);
    session.read(
        "/api/join?origin=" + RoomApi.encode(session.api.server),
        value -> {
          loading = false;
          if (closed) return;
          try {
            String data = ((JSONObject) value).getString("qr");
            byte[] bytes = Base64.decode(data.substring(data.indexOf(',') + 1), Base64.DEFAULT);
            android.graphics.Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bitmap != null) {
              qr.setImageBitmap(bitmap);
              loaded = true;
            }
          } catch (Exception ignored) {
          }
        });
  }

  void queue(JSONArray value) {
    queue = value == null ? new JSONArray() : value;
    String key = queue.toString();
    if (queueKey.equals(key)) return;
    queueKey = key;
    queuePanel.removeAllViews();
    queuePanel.addView(TvStyle.text(getContext(), "已点歌曲 · " + queue.length(), 11, TvStyle.ACCENT));
    for (int i = 0; i < Math.min(4, queue.length()); i++) {
      JSONObject song = queue.optJSONObject(i);
      TextView row =
          TvStyle.text(
              getContext(),
              (i == 0 ? "正在唱  " : (i + 1) + "  ") + song.optString("title"),
              12,
              TvStyle.INK);
      row.setSingleLine();
      row.setEllipsize(android.text.TextUtils.TruncateAt.END);
      queuePanel.addView(row, new LayoutParams(-1, dp(27)));
    }
    if (queue.length() > 4)
      queuePanel.addView(
          TvStyle.text(getContext(), "还有 " + (queue.length() - 4) + " 首待唱", 10, TvStyle.MUTED));
    if (full) showQueue();
  }

  private void queuePanelVisibility(boolean visible) {
    queuePanel.setVisibility(visible && queue.length() > 0 ? VISIBLE : GONE);
  }

  private void showQueue() {
    queuePanelVisibility(true);
    handler.removeCallbacks(hideQueue);
    handler.postDelayed(hideQueue, 6000);
  }

  public void close() {
    closed = true;
    handler.removeCallbacksAndMessages(null);
  }
}
