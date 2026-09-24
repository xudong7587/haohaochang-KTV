package home.haohaochang.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Entire TV room is native: one permanent SurfaceView, recycled catalogue, native lyrics and
 * controls.
 */
final class NativeRoom extends FrameLayout implements RoomSession.Listener, AutoCloseable {
  interface Actions {
    void settings();

    void authRequired();
  }

  private final Activity activity;
  private final Actions actions;
  private final SharedPreferences preferences;
  private final RoomSession session;
  private final NativePlayback player;
  private final NativeLyricsView lyrics;
  private final FrameLayout stage, footer;
  private final LinearLayout sidebar, controls, leftAdjust, rightAdjust, nowPlaying, lyricInfo;
  private final Map<String, Button> navigation = new LinkedHashMap<>();
  private final TextView subtitle, roomBadge;
  private int layoutWidth, layoutHeight;
  private final NativeCatalogue catalogue;
  private final NativeRoomOverlay overlay;
  private final TextView title, status, offsetLabel, stageTitle;
  private final Button pause, vocal, next, fullscreen, lyricToggle, queueButton, reset, settings;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private JSONObject current, playback = new JSONObject(), stats = new JSONObject();
  private String tab = "stage", mediaEntry = "", lastEnded = "", error = "", lastStatus = "";
  private String roomCode = "";

  String roomName() { return roomCode.isEmpty() ? "家庭默认歌房" : "歌房 " + roomCode; }
  private boolean full,
      controlsVisible = true,
      lyricsVisible,
      lease,
      closed,
      foreground = true,
      dialogOpen,
      authReported,
      lastNativePlaying;
  private double lyricBaseOffset;
  private int queueCount;
  private boolean lastPaused = true;
  private int wakeKey = -1;
  private String pageBeforeFull = "stage";
  private View confirmTarget;
  private boolean longConfirmed;
  private final Runnable longConfirm = this::longConfirm;

  private void longConfirm() {
    View target = confirmTarget;
    if (target != null && target == findFocus() && target.isShown())
      longConfirmed = catalogue.longActivate(target);
  }

  private TextView controlHint;
  private View hintAnchor;
  private final Runnable clearHint = this::hideHint;

  NativeRoom(Activity activity, RoomApi api, Actions actions) {
    this(activity, api, actions, true);
  }

  NativeRoom(Activity activity, RoomApi api, Actions actions, boolean connect) {
    super(activity);
    this.activity = activity;
    this.actions = actions;
    preferences = activity.getSharedPreferences("native-room", Activity.MODE_PRIVATE);
    lyricsVisible = preferences.getBoolean("lyrics", true);
    setBackgroundColor(TvStyle.BACKGROUND);
    setDescendantFocusability(FOCUS_AFTER_DESCENDANTS);
    setFocusable(false);
    session = new RoomSession(api, this);
    session.deviceType = (getResources().getConfiguration().uiMode
        & android.content.res.Configuration.UI_MODE_TYPE_MASK)
        == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION ? "tv" : "web";
    stage = new FrameLayout(activity);
    stage.setBackgroundColor(Color.BLACK);
    stage.setFocusable(true);
    stage.setFocusableInTouchMode(true);
    stage.setContentDescription("演唱画面，确认键全屏");
    addView(stage);
    player = new NativePlayback(activity, stage, this::nativeState);
    player.configure(api.server);
    stageTitle = TvStyle.text(activity, "客厅的舞台，留给你", 24, TvStyle.INK);
    stageTitle.setGravity(Gravity.CENTER);
    stage.addView(stageTitle, new FrameLayout.LayoutParams(-1, -1));
    lyrics =
        new NativeLyricsView(
            activity,
            new NativeLyricsView.Clock() {
              public long timeMs() {
                return player.timeMs();
              }

              public boolean playing() {
                return player.playing();
              }
            });
    stage.addView(lyrics, new FrameLayout.LayoutParams(-1, -1));
    overlay = new NativeRoomOverlay(activity, session);
    FrameLayout.LayoutParams overlayParams =
        new FrameLayout.LayoutParams(dp(176), -2, Gravity.TOP | Gravity.RIGHT);
    overlayParams.topMargin = dp(20);
    overlayParams.rightMargin = dp(22);
    stage.addView(overlay, overlayParams);
    stage.setOnClickListener(
        v -> {
          if (full) reveal(true);
          else setFull(true);
        });
    sidebar = new LinearLayout(activity);
    sidebar.setOrientation(LinearLayout.VERTICAL);
    sidebar.setPadding(dp(12), dp(12), dp(12), dp(10));
    sidebar.setBackground(TvStyle.panel(activity));
    addView(sidebar);
    LinearLayout brand = new LinearLayout(activity);
    brand.setGravity(Gravity.CENTER_VERTICAL);
    ImageView mark = new ImageView(activity);
    mark.setImageResource(R.drawable.icon);
    brand.addView(mark, new LinearLayout.LayoutParams(dp(34), dp(34)));
    LinearLayout wordmark = new LinearLayout(activity);
    wordmark.setOrientation(LinearLayout.VERTICAL);
    wordmark.setPadding(dp(8), 0, 0, 0);
    wordmark.addView(TvStyle.text(activity, "好好唱", 21, TvStyle.INK));
    TextView english = TvStyle.text(activity, "HOME KARAOKE", 6, TvStyle.MUTED);
    english.setLetterSpacing(.16f);
    wordmark.addView(english);
    brand.addView(wordmark);
    sidebar.addView(brand, new LinearLayout.LayoutParams(-1, dp(46)));
    roomBadge = TvStyle.text(activity, "我的客厅\n已连接 · NAS", 10, TvStyle.MUTED);
    roomBadge.setGravity(Gravity.CENTER_VERTICAL);
    roomBadge.setPadding(dp(10), 0, dp(8), 0);
    roomBadge.setLineSpacing(dp(5), 1);
    roomBadge.setBackground(TvStyle.surface(activity, 0xff2b2339, 0xff211b2b, 9, 0x14e5d2ff));
    sidebar.addView(roomBadge, new LinearLayout.LayoutParams(-1, dp(32)));
    TextView label = TvStyle.text(activity, "发现你的下一首", 9, TvStyle.MUTED);
    label.setGravity(Gravity.CENTER_VERTICAL);
    label.setPadding(dp(6), 0, 0, 0);
    sidebar.addView(label, new LinearLayout.LayoutParams(-1, dp(22)));
    nav("音乐现场", "stage");
    nav("歌名点歌", "songs");
    nav("歌星点歌", "artists");

    queueButton = nav("已点歌曲", "queue");
    nav("在线找歌", "online");
    sidebar.addView(new View(activity), new LinearLayout.LayoutParams(1, 0, 1));
    settings = TvStyle.button(activity, "设置", "设置", actions::settings);
    TvStyle.icon(settings, "settings");
    LinearLayout.LayoutParams settingsParams = new LinearLayout.LayoutParams(-1, dp(32));
    settingsParams.topMargin = dp(8);
    sidebar.addView(settings, settingsParams);
    catalogue = new NativeCatalogue(activity, session);
    addView(catalogue);
    catalogue.setVisibility(GONE);
    footer = new FrameLayout(activity);
    footer.setBackground(TvStyle.footer(activity));
    footer.setElevation(dp(4));
    addView(footer);
    nowPlaying = new LinearLayout(activity);
    nowPlaying.setGravity(Gravity.CENTER_VERTICAL);
    footer.addView(nowPlaying);
    ImageView record = new ImageView(activity);
    record.setImageDrawable(
        new TvIcon(activity, "record", ColorStateList.valueOf(TvStyle.ACCENT), 24));
    record.setPadding(dp(8), dp(8), dp(8), dp(8));
    record.setBackground(TvStyle.surface(activity, 0xff4a3c60, 0xff2a2237, 24, 0x20e6d5ff));
    nowPlaying.addView(record, new LinearLayout.LayoutParams(dp(40), dp(40)));
    LinearLayout track = new LinearLayout(activity);
    track.setOrientation(LinearLayout.VERTICAL);
    track.setPadding(dp(10), 0, 0, 0);
    nowPlaying.addView(track, new LinearLayout.LayoutParams(0, -2, 1));
    title = TvStyle.text(activity, "下一首，就唱你喜欢的", 14, TvStyle.INK);
    title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
    title.setSingleLine();
    title.setEllipsize(android.text.TextUtils.TruncateAt.END);
    title.setOnClickListener(v -> show("stage"));
    track.addView(title);
    subtitle = TvStyle.text(activity, "点一首歌，开启今晚的好时光", 10, TvStyle.MUTED);
    subtitle.setSingleLine();
    subtitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
    subtitle.setPadding(0, dp(5), 0, 0);
    track.addView(subtitle);
    lyricInfo = new LinearLayout(activity);
    lyricInfo.setGravity(Gravity.CENTER_VERTICAL);
    footer.addView(lyricInfo);
    offsetLabel = TvStyle.text(activity, "歌词原始时间", 12, TvStyle.MUTED);
    lyricInfo.addView(offsetLabel);
    reset = TvStyle.button(activity, "复位", "重置歌词微调", () -> adjust(0, true));
    TvStyle.iconOnly(reset, "reset");
    lyricInfo.addView(reset, new LinearLayout.LayoutParams(dp(44), dp(28)));
    controls = new LinearLayout(activity);
    controls.setGravity(Gravity.CENTER_VERTICAL);
    footer.addView(controls);
    lyricToggle = TvStyle.button(activity, "歌词", "隐藏歌词", this::toggleLyrics);
    TvStyle.iconOnly(lyricToggle, "lyrics");
    controls.addView(lyricToggle, new LinearLayout.LayoutParams(dp(44), -1));
    leftAdjust = adjustGroup(new double[] {10, 3, .5}, false);
    controls.addView(new View(activity), new LinearLayout.LayoutParams(0, 1, 1));
    controls.addView(leftAdjust, new LinearLayout.LayoutParams(dp(132), -1));
    LinearLayout mainControls = new LinearLayout(activity);
    mainControls.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams centerParams = new LinearLayout.LayoutParams(dp(148), -1);
    centerParams.leftMargin = dp(8);
    centerParams.rightMargin = dp(8);
    controls.addView(mainControls, centerParams);
    vocal = TvStyle.button(activity, "伴奏", "切换原唱伴奏", () -> control("vocal"));
    TvStyle.iconOnly(vocal, "mic");
    mainControls.addView(vocal, new LinearLayout.LayoutParams(dp(44), -1));
    pause = TvStyle.button(activity, "Ⅱ", "暂停", () -> control("pause"));
    LinearLayout.LayoutParams pauseParams = new LinearLayout.LayoutParams(dp(44), -1);
    pauseParams.leftMargin = dp(8);
    pauseParams.rightMargin = dp(8);
    mainControls.addView(pause, pauseParams);
    pause.setTextSize(22);
    TvStyle.primary(pause);
    next = TvStyle.button(activity, "切歌", "切歌", () -> control("next"));
    TvStyle.iconOnly(next, "next");
    mainControls.addView(next, new LinearLayout.LayoutParams(dp(44), -1));
    rightAdjust = adjustGroup(new double[] {.5, 3, 10}, true);
    controls.addView(rightAdjust, new LinearLayout.LayoutParams(dp(132), -1));
    controls.addView(new View(activity), new LinearLayout.LayoutParams(0, 1, 1));
    fullscreen = TvStyle.button(activity, "全屏", "全屏播放", () -> setFull(!full));
    TvStyle.iconOnly(fullscreen, "screen");
    controls.addView(fullscreen, new LinearLayout.LayoutParams(dp(44), -1));
    status = TvStyle.text(activity, "正在连接播放会话…", 13, TvStyle.INK);
    status.setBackground(TvStyle.surface(activity, 0xfa362b46, 0xf5231c2e, 10, 0x25e4d4fa));
    status.setElevation(dp(3));
    status.setPadding(dp(12), dp(8), dp(12), dp(8));
    FrameLayout.LayoutParams statusParams =
        new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
    statusParams.topMargin = dp(8);
    addView(status, statusParams);
    controlHint = TvStyle.text(activity, "", 11, TvStyle.INK);
    controlHint.setContentDescription("播放控制提示");
    controlHint.setGravity(Gravity.CENTER);
    controlHint.setPadding(dp(10), dp(6), dp(10), dp(6));
    controlHint.setBackground(TvStyle.surface(activity, 0xfa42354f, 0xfa2b2336, 8, 0x30eadcff));
    controlHint.setElevation(dp(3));
    controlHint.setVisibility(GONE);
    controlHint.setFocusable(false);
    addView(controlHint);
    List<View> hintButtons = new ArrayList<>();
    collectAllButtons(footer, hintButtons);
    for (View view : hintButtons)
      view.setOnFocusChangeListener(
          (button, focused) -> {
            if (focused) showHint(button);
            else if (hintAnchor == button) hideHint();
          });
    layoutRoom();
    show("stage");
    updateControls();
    if (connect) session.start();
  }

  private int dp(float n) {
    return TvStyle.dp(activity, n);
  }

  private Button nav(String text, String page) {
    Button button = TvStyle.button(activity, text, text, () -> show(page));
    button.setGravity(Gravity.CENTER_VERTICAL | Gravity.LEFT);
    button.setTextSize(12);
    button.setPadding(dp(9), 0, dp(6), 0);
    TvStyle.icon(
        button,
        page.equals("stage")
            ? "play"
            : page.equals("artists")
                ? "users"
                : page.equals("online") ? "globe" : page.equals("songs") ? "music" : "list");
    navigation.put(page, button);
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, dp(34));
    p.bottomMargin = dp(5);
    sidebar.addView(button, p);
    return button;
  }

  private LinearLayout adjustGroup(double[] steps, boolean advance) {
    LinearLayout group = new LinearLayout(activity);
    group.setGravity(Gravity.CENTER);
    for (double seconds : steps) {
      String number = seconds >= 1 ? String.valueOf((int) seconds) : String.valueOf(seconds);
      Button b =
          TvStyle.button(
              activity,
              number + "\n" + (advance ? "→" : "←"),
              "歌词" + (advance ? "提前 " : "延后 ") + number + " 秒",
              () -> adjust((int) (seconds * 1000) * (advance ? 1 : -1), false));
      b.setTextSize(14);
      b.setSingleLine(false);
      b.setMaxLines(2);
      b.setIncludeFontPadding(false);
      android.text.SpannableString caption = new android.text.SpannableString(b.getText());
      caption.setSpan(
          new android.text.style.RelativeSizeSpan(.8f), number.length() + 1, caption.length(), 0);
      b.setText(caption);
      TvStyle.subtle(b);
      b.setPadding(0, 0, 0, 0);
      LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, dp(40), 1);
      p.leftMargin = dp(2);
      group.addView(b, p);
    }
    return group;
  }

  private void layoutRoom() {
    if (layoutWidth > 0 && layoutWidth < dp(900)) {
      layoutCompact();
      return;
    }
    catalogue.compact(false);
    title.setTextSize(14);
    subtitle.setTextSize(10);
    LinearLayout mainControls = (LinearLayout) controls.getChildAt(3);
    LinearLayout.LayoutParams center = new LinearLayout.LayoutParams(dp(148), -1);
    center.leftMargin = center.rightMargin = dp(8);
    mainControls.setLayoutParams(center);
    for (int i = 0; i < mainControls.getChildCount(); i++) {
      LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(dp(44), -1);
      if (i == 1) p.leftMargin = p.rightMargin = dp(8);
      mainControls.getChildAt(i).setLayoutParams(p);
    }
    fullscreen.setLayoutParams(new LinearLayout.LayoutParams(dp(44), -1));
    sidebar.setOrientation(LinearLayout.VERTICAL);
    sidebar.setPadding(dp(12), dp(12), dp(12), dp(10));
    for (int i = 0; i < sidebar.getChildCount(); i++) {
      View child = sidebar.getChildAt(i);
      child.setVisibility(VISIBLE);
      if (child instanceof Button) {
        Button button = (Button) child;
        button.setBackground(TvStyle.focus(activity));
        button.setTextColor(TvStyle.ink());
        button.setTextSize(12);
        button.setGravity(Gravity.CENTER_VERTICAL | Gravity.LEFT);
        button.setPadding(dp(9), 0, dp(6), 0);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, dp(34));
        p.bottomMargin = dp(5);
        if (button == settings) p.topMargin = dp(12);
        button.setLayoutParams(p);
      }
    }
    overlay.setVisibility(VISIBLE);
    for (LinearLayout group : new LinearLayout[] {leftAdjust, rightAdjust}) {
      group.setLayoutParams(new LinearLayout.LayoutParams(dp(132), -1));
      for (int i = 0; i < group.getChildCount(); i++) group.getChildAt(i).setVisibility(VISIBLE);
    }
    int nav = full ? 0 : dp(144), bar = dp(full ? 84 : 72);
    FrameLayout.LayoutParams stageParams = new FrameLayout.LayoutParams(-1, -1);
    stageParams.leftMargin = nav;
    stageParams.bottomMargin = full ? 0 : bar;
    stage.setLayoutParams(stageParams);
    FrameLayout.LayoutParams navParams = new FrameLayout.LayoutParams(dp(144), -1);
    navParams.bottomMargin = bar;
    sidebar.setLayoutParams(navParams);
    FrameLayout.LayoutParams libraryParams = new FrameLayout.LayoutParams(-1, -1);
    libraryParams.leftMargin = nav;
    libraryParams.rightMargin = 0;
    libraryParams.bottomMargin = bar;
    catalogue.setLayoutParams(libraryParams);
    footer.setLayoutParams(new FrameLayout.LayoutParams(-1, bar, Gravity.BOTTOM));
    FrameLayout.LayoutParams trackParams =
        new FrameLayout.LayoutParams(
            full ? dp(360) : dp(268),
            full ? dp(30) : dp(56),
            full ? Gravity.TOP | Gravity.LEFT : Gravity.CENTER_VERTICAL | Gravity.LEFT);
    trackParams.leftMargin = dp(18);
    trackParams.topMargin = full ? dp(3) : 0;
    nowPlaying.setLayoutParams(trackParams);
    nowPlaying.getChildAt(0).setVisibility(full ? GONE : VISIBLE);
    subtitle.setVisibility(full ? GONE : VISIBLE);
    FrameLayout.LayoutParams adjustmentParams =
        new FrameLayout.LayoutParams(-2, dp(28), Gravity.TOP | Gravity.RIGHT);
    adjustmentParams.rightMargin = dp(16);
    adjustmentParams.topMargin = dp(3);
    lyricInfo.setLayoutParams(adjustmentParams);
    FrameLayout.LayoutParams controlsParams =
        new FrameLayout.LayoutParams(-1, dp(44), full ? Gravity.BOTTOM : Gravity.CENTER_VERTICAL);
    controlsParams.leftMargin = dp(16);
    controlsParams.rightMargin = dp(16);
    controlsParams.bottomMargin = full ? dp(7) : 0;
    controls.setLayoutParams(controlsParams);
    sidebar.setVisibility(full ? GONE : VISIBLE);
    catalogue.setVisibility(!full && !tab.equals("stage") ? VISIBLE : GONE);
    lyrics.setVisibility(lyricsVisible && full ? VISIBLE : GONE);
    ViewGroup overlayParent = full ? stage : sidebar;
    if (overlay.getParent() != overlayParent) {
      ((ViewGroup) overlay.getParent()).removeView(overlay);
      if (full) {
        FrameLayout.LayoutParams p =
            new FrameLayout.LayoutParams(dp(176), -2, Gravity.TOP | Gravity.RIGHT);
        p.topMargin = dp(20);
        p.rightMargin = dp(22);
        stage.addView(overlay, p);
      } else {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
        p.gravity = Gravity.CENTER_HORIZONTAL;
        sidebar.addView(overlay, sidebar.getChildCount() - 1, p);
      }
    }
    overlay.fullscreen(full);
    lyricToggle.setVisibility(full ? VISIBLE : INVISIBLE);
    stage.setContentDescription(full ? "演唱画面，按下键打开控制，左右键微调歌词" : "演唱画面，确认键全屏");
    updateAdjustmentVisibility();
  }

  @Override
  protected void onMeasure(int widthSpec, int heightSpec) {
    int width = MeasureSpec.getSize(widthSpec), height = MeasureSpec.getSize(heightSpec);
    if (layoutWidth != width || layoutHeight != height) {
      layoutWidth = width;
      layoutHeight = height;
      layoutRoom();
    }
    FrameLayout.LayoutParams p = (FrameLayout.LayoutParams) catalogue.getLayoutParams();
    p.rightMargin = 0;
    super.onMeasure(widthSpec, heightSpec);
  }

  private void layoutCompact() {
    boolean portrait = layoutHeight > layoutWidth;
    catalogue.compact(true);
    int bar = dp(full ? 80 : portrait ? 56 : 48), nav = portrait ? 0 : dp(88), tabs = portrait ? dp(44) : 0;
    FrameLayout.LayoutParams sp = new FrameLayout.LayoutParams(-1, -1);
    sp.leftMargin = full ? 0 : nav;
    sp.topMargin = full ? 0 : tabs;
    sp.bottomMargin = full ? 0 : bar;
    stage.setLayoutParams(sp);
    sidebar.setOrientation(portrait ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
    sidebar.setPadding(dp(4), dp(4), dp(4), dp(4));
    for (int i = 0; i < sidebar.getChildCount(); i++) {
      View child = sidebar.getChildAt(i);
      boolean button = child instanceof Button;
      child.setVisibility(button ? VISIBLE : GONE);
      if (button) {
        Button b = (Button) child;
        b.setTextSize(portrait ? 9 : 10);
        b.setTextColor(TvStyle.INK);
        TvStyle.phoneTab(b);
        b.setPadding(dp(2), 0, dp(2), 0);
        b.setCompoundDrawables(null, null, null, null);
        b.setGravity(Gravity.CENTER);
        child.setLayoutParams(portrait
            ? new LinearLayout.LayoutParams(0, -1, 1)
            : new LinearLayout.LayoutParams(-1, dp(40)));
      }
    }
    FrameLayout.LayoutParams np = new FrameLayout.LayoutParams(portrait ? -1 : nav, portrait ? tabs : -1);
    np.bottomMargin = portrait ? 0 : bar;
    sidebar.setLayoutParams(np);
    sidebar.setVisibility(full ? GONE : VISIBLE);
    FrameLayout.LayoutParams cp = new FrameLayout.LayoutParams(-1, -1);
    cp.leftMargin = nav;
    cp.topMargin = tabs;
    cp.bottomMargin = bar;
    catalogue.setLayoutParams(cp);
    catalogue.setVisibility(!full && !tab.equals("stage") ? VISIBLE : GONE);
    footer.setLayoutParams(new FrameLayout.LayoutParams(-1, bar, Gravity.BOTTOM));
    FrameLayout.LayoutParams track = new FrameLayout.LayoutParams(-1, dp(full ? 26 : 42), full ? Gravity.TOP : Gravity.CENTER_VERTICAL);
    track.leftMargin = dp(10);
    track.rightMargin = dp(full ? 130 : 190);
    nowPlaying.setLayoutParams(track);
    nowPlaying.getChildAt(0).setVisibility(GONE);
    title.setTextSize(12);
    subtitle.setVisibility(full ? GONE : VISIBLE);
    subtitle.setTextSize(9);
    FrameLayout.LayoutParams info = new FrameLayout.LayoutParams(-2, dp(30), Gravity.TOP | Gravity.RIGHT);
    lyricInfo.setLayoutParams(info);
    offsetLabel.setTextSize(9);
    FrameLayout.LayoutParams buttons = new FrameLayout.LayoutParams(full ? -1 : dp(180), dp(44), full ? Gravity.BOTTOM : Gravity.RIGHT | Gravity.CENTER_VERTICAL);
    buttons.leftMargin = dp(4);
    buttons.rightMargin = dp(4);
    buttons.bottomMargin = full ? dp(6) : 0;
    controls.setLayoutParams(buttons);
    LinearLayout mainControls = (LinearLayout) controls.getChildAt(3);
    LinearLayout.LayoutParams center = new LinearLayout.LayoutParams(dp(full ? 148 : 116), -1);
    center.leftMargin = center.rightMargin = dp(full ? 8 : 4);
    mainControls.setLayoutParams(center);
    for (int i = 0; i < mainControls.getChildCount(); i++) {
      LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(dp(full ? 44 : 36), dp(full ? 44 : 36));
      if (i == 1) p.leftMargin = p.rightMargin = dp(full ? 8 : 4);
      mainControls.getChildAt(i).setLayoutParams(p);
    }
    fullscreen.setLayoutParams(new LinearLayout.LayoutParams(dp(full ? 44 : 36), dp(full ? 44 : 36)));
    for (LinearLayout group : new LinearLayout[] {leftAdjust, rightAdjust}) {
      group.setLayoutParams(new LinearLayout.LayoutParams(dp(portrait ? 44 : 132), -1));
      for (int i = 0; i < group.getChildCount(); i++) {
        View child = group.getChildAt(i);
        child.setVisibility(!portrait || child.getContentDescription().toString().contains("0.5") ? VISIBLE : GONE);
      }
    }
    overlay.setVisibility(GONE);
    lyrics.setVisibility(lyricsVisible && full ? VISIBLE : GONE);
    lyricToggle.setVisibility(full ? VISIBLE : GONE);
    updateAdjustmentVisibility();
  }

  private void updateAdjustmentVisibility() {
    // Keep equal-width flanks when hidden so the shared pause button never moves.
    int hidden = !full && layoutWidth > 0 && layoutWidth < dp(900) ? GONE : INVISIBLE;
    leftAdjust.setVisibility(full && lyricsVisible && current != null ? VISIBLE : hidden);
    rightAdjust.setVisibility(full && lyricsVisible && current != null ? VISIBLE : hidden);
    offsetLabel.setVisibility(full && lyricsVisible && current != null ? VISIBLE : GONE);
    reset.setVisibility(offsetLabel.getVisibility());
    lyricInfo.setVisibility(offsetLabel.getVisibility());
  }

  private void show(String value) {
    tab = value;
    catalogue.setVisibility(tab.equals("stage") ? GONE : VISIBLE);
    if (!tab.equals("stage")) catalogue.show(tab);
    layoutRoom();
    for (Map.Entry<String, Button> item : navigation.entrySet())
      item.getValue().setSelected(item.getKey().equals(tab));
    focusInitial();
  }

  void focusInitial() {
    Button selected = navigation.get(tab);
    if (full) focusPlayback();
    else if (selected != null) selected.requestFocusFromTouch();
  }

  private void focusPlayback() {
    if (!pause.requestFocusFromTouch()) fullscreen.requestFocusFromTouch();
  }

  private void focusContent() {
    if (catalogue.getVisibility() == VISIBLE) catalogue.focusGrid();
    else stage.requestFocusFromTouch();
  }

  private void setFull(boolean value) {
    if (full == value) return;
    hideHint();
    if (value) pageBeforeFull = tab;
    full = value;
    controlsVisible = true;
    TvStyle.glyph(fullscreen, full ? "exit" : "screen", false);
    fullscreen.setContentDescription(full ? "退出全屏" : "全屏播放");
    layoutRoom();
    footer.setVisibility(VISIBLE);
    if (full) {
      stage.requestFocusFromTouch();
      armHide();
    } else {
      handler.removeCallbacks(hideControls);
      tab = pageBeforeFull;
      layoutRoom();
      fullscreen.requestFocusFromTouch();
    }
  }

  private final Runnable hideControls = this::hidePanel;

  private void hidePanel() {
    if (!full || paused() || dialogOpen || !error.isEmpty()) return;
    controlsVisible = false;
    hideHint();
    stage.requestFocusFromTouch();
    footer.setVisibility(GONE);
  }

  private void armHide() {
    handler.removeCallbacks(hideControls);
    if (full && !paused()) handler.postDelayed(hideControls, 4000);
  }

  private void reveal(boolean focus) {
    controlsVisible = true;
    footer.setVisibility(VISIBLE);
    if (focus) focusPlayback();
    armHide();
  }

  private void showHint(View button) {
    if (controlHint == null || !button.isShown()) return;
    handler.removeCallbacks(clearHint);
    hintAnchor = button;
    String text = String.valueOf(button.getContentDescription());
    if (button == vocal) text += variant().equals("vocal") ? " · 当前原唱" : " · 当前伴奏";
    controlHint.setText(text);
    controlHint.measure(
        MeasureSpec.makeMeasureSpec(Math.max(dp(180), getWidth()), MeasureSpec.AT_MOST),
        MeasureSpec.makeMeasureSpec(dp(40), MeasureSpec.AT_MOST));
    android.graphics.Rect bounds = new android.graphics.Rect();
    button.getDrawingRect(bounds);
    offsetDescendantRectToMyCoords(button, bounds);
    FrameLayout.LayoutParams p = new FrameLayout.LayoutParams(-2, -2);
    p.leftMargin =
        Math.max(
            dp(8),
            Math.min(
                getWidth() - controlHint.getMeasuredWidth() - dp(8),
                bounds.centerX() - controlHint.getMeasuredWidth() / 2));
    p.topMargin = Math.max(dp(8), bounds.top - controlHint.getMeasuredHeight() - dp(8));
    controlHint.setLayoutParams(p);
    controlHint.setVisibility(VISIBLE);
    handler.postDelayed(clearHint, 1600);
  }

  private void hideHint() {
    handler.removeCallbacks(clearHint);
    if (controlHint != null) controlHint.setVisibility(GONE);
    hintAnchor = null;
  }

  private static void collectAllButtons(View root, List<View> result) {
    if (root instanceof Button) result.add(root);
    else if (root instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) root;
      for (int i = 0; i < group.getChildCount(); i++)
        collectAllButtons(group.getChildAt(i), result);
    }
  }

  boolean back() {
    if (full) {
      if (!controlsVisible) {
        reveal(true);
      } else if (footer.hasFocus()) {
        controlsVisible = false;
        handler.removeCallbacks(hideControls);
        stage.requestFocusFromTouch();
        footer.setVisibility(GONE);
      } else reveal(true);
      return true;
    }
    if (catalogue.getVisibility() == VISIBLE && catalogue.back()) return true;
    if (catalogue.hasFocus() || footer.hasFocus() || stage.hasFocus()) {
      focusInitial();
      return true;
    }
    if (!tab.equals("stage")) {
      show("stage");
      return true;
    }
    return false;
  }

  @Override
  public boolean dispatchKeyEvent(KeyEvent event) {
    if (event.getKeyCode() == wakeKey) {
      if (event.getAction() == KeyEvent.ACTION_UP) wakeKey = -1;
      return true;
    }
    int key = event.getKeyCode();
    boolean confirm =
        key == KeyEvent.KEYCODE_DPAD_CENTER
            || key == KeyEvent.KEYCODE_ENTER
            || key == KeyEvent.KEYCODE_NUMPAD_ENTER;
    if (event.getAction() == KeyEvent.ACTION_UP && confirm && confirmTarget != null) {
      handler.removeCallbacks(longConfirm);
      View target = confirmTarget;
      confirmTarget = null;
      target.setPressed(false);
      if (!longConfirmed
          && !event.isCanceled()
          && target == findFocus()
          && target.isShown()
          && target.isEnabled()) {
        if (!catalogue.activate(target)) target.performClick();
      }
      return true;
    }
    if (event.getAction() != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(event);
    if (key == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
      control("pause");
      return true;
    }
    if (key == KeyEvent.KEYCODE_MEDIA_NEXT) {
      control("next");
      return true;
    }
    if (full) {
      boolean wake =
          key == KeyEvent.KEYCODE_DPAD_CENTER
              || key == KeyEvent.KEYCODE_ENTER
              || key == KeyEvent.KEYCODE_DPAD_DOWN;
      boolean arrow = key >= KeyEvent.KEYCODE_DPAD_UP && key <= KeyEvent.KEYCODE_DPAD_RIGHT;
      if (!controlsVisible && (wake || arrow)) {
        if (event.getRepeatCount() == 0) {
          wakeKey = key;
          reveal(true);
        }
        return true;
      }
      if (stage.hasFocus() && wake) {
        if (event.getRepeatCount() == 0) {
          wakeKey = key;
          reveal(true);
        }
        return true;
      }
      if (stage.hasFocus()
          && lyricsVisible
          && (key == KeyEvent.KEYCODE_DPAD_LEFT || key == KeyEvent.KEYCODE_DPAD_RIGHT)) {
        if (event.getRepeatCount() == 0)
          adjust(key == KeyEvent.KEYCODE_DPAD_LEFT ? -500 : 500, false);
        return true;
      }
      armHide();
    }
    if (key >= KeyEvent.KEYCODE_DPAD_UP && key <= KeyEvent.KEYCODE_DPAD_RIGHT) {
      if (findFocus() instanceof android.widget.EditText
          && ((android.widget.EditText) findFocus()).length() > 0
          && (key == KeyEvent.KEYCODE_DPAD_LEFT || key == KeyEvent.KEYCODE_DPAD_RIGHT))
        return super.dispatchKeyEvent(event);
      handler.removeCallbacks(longConfirm);
      if (confirmTarget != null) confirmTarget.setPressed(false);
      confirmTarget = null;
      navigate(key);
      return true;
    }
    if (confirm && !(findFocus() instanceof android.widget.EditText)) {
      if (event.getRepeatCount() == 0) {
        View target = findFocus();
        if (target == null || target == this) {
          focusInitial();
          target = findFocus();
        }
        longConfirmed = false;
        confirmTarget = target;
        handler.postDelayed(longConfirm, 600);
        if (target != null) target.setPressed(true);
      }
      return true;
    }
    return super.dispatchKeyEvent(event);
  }

  /** Explicit TV zones: never depend on a vendor's focus search or touch-mode transition. */
  private void navigate(int key) {
    View focused = findFocus();
    if (focused == null || focused == this || !focused.isShown()) {
      focusInitial();
      return;
    }
    if (sidebar.hasFocus()) {
      if (key == KeyEvent.KEYCODE_DPAD_RIGHT) {
        for (Map.Entry<String, Button> item : navigation.entrySet()) {
          if (item.getValue() == focused && !item.getKey().equals(tab)) {
            show(item.getKey());
            break;
          }
        }
        focusContent();
      } else if (key == KeyEvent.KEYCODE_DPAD_DOWN || key == KeyEvent.KEYCODE_DPAD_UP) {
        List<View> buttons = new ArrayList<>();
        collectButtons(sidebar, buttons);
        int index = buttons.indexOf(focused) + (key == KeyEvent.KEYCODE_DPAD_DOWN ? 1 : -1);
        if (index >= buttons.size()) focusPlayback();
        else if (index >= 0) buttons.get(index).requestFocusFromTouch();
      }
      return;
    }
    if (catalogue.hasFocus()) {
      if (!catalogue.move(key)) {
        if (key == KeyEvent.KEYCODE_DPAD_LEFT) focusInitial();
        else if (key == KeyEvent.KEYCODE_DPAD_DOWN) focusPlayback();
      }
      return;
    }
    if (footer.hasFocus()) {
      if (key == KeyEvent.KEYCODE_DPAD_UP) {
        if (full && reset.isShown() && focused != reset) reset.requestFocusFromTouch();
        else if (full) stage.requestFocusFromTouch();
        else focusContent();
      } else if (key == KeyEvent.KEYCODE_DPAD_DOWN && focused == reset) focusPlayback();
      else if (key == KeyEvent.KEYCODE_DPAD_LEFT || key == KeyEvent.KEYCODE_DPAD_RIGHT) {
        List<View> buttons = new ArrayList<>();
        collectButtons(controls, buttons);
        int index = buttons.indexOf(focused) + (key == KeyEvent.KEYCODE_DPAD_RIGHT ? 1 : -1);
        if (index >= 0 && index < buttons.size()) buttons.get(index).requestFocusFromTouch();
        else if (!full && key == KeyEvent.KEYCODE_DPAD_LEFT) focusInitial();
      }
      return;
    }
    if (stage.hasFocus()) {
      if (!full && (key == KeyEvent.KEYCODE_DPAD_LEFT || key == KeyEvent.KEYCODE_DPAD_UP))
        focusInitial();
      else if (!full && key == KeyEvent.KEYCODE_DPAD_RIGHT) fullscreen.requestFocusFromTouch();
      else reveal(true);
    }
  }

  private static void collectButtons(View root, List<View> result) {
    if (!root.isShown() || !root.isEnabled()) return;
    if (root instanceof Button) result.add(root);
    else if (root instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) root;
      for (int i = 0; i < group.getChildCount(); i++) collectButtons(group.getChildAt(i), result);
    }
  }

  private boolean paused() {
    return current == null || current.optBoolean("ambient")
        ? current == null || current.optBoolean("paused")
        : playback.optBoolean("paused");
  }

  private String variant() {
    return current != null
                && (current.optBoolean("ambient") || current.optString("mode").equals("original"))
            || playback.optBoolean("vocal")
        ? "vocal"
        : "backing";
  }

  private void control(String action) {
    if (current == null) return;
    session.command(
        "/api/control",
        "POST",
        RoomApi.object("action", action, "entryId", current.optString("id")),
        null);
    reveal(false);
  }

  private void adjust(int delta, boolean reset) {
    if (current == null) return;
    session.command(
        "/api/control",
        "POST",
        RoomApi.object(
            "action",
            "lyrics-offset",
            "entryId",
            current.optString("id"),
            "deltaMs",
            delta,
            "reset",
            reset),
        null);
    armHide();
  }

  private void toggleLyrics() {
    lyricsVisible = !lyricsVisible;
    preferences.edit().putBoolean("lyrics", lyricsVisible).apply();
    layoutRoom();
    updateControls();
    armHide();
  }

  private void updateControls() {
    boolean has = current != null;
    pause.setEnabled(has);
    next.setEnabled(has);
    lyricToggle.setEnabled(has);
    vocal.setEnabled(
        has
            && !current.optBoolean("ambient")
            && !current.optString("mode").equals("original")
            && !current.optString("mode").equals("instrumental"));
    String voice =
        has && current.optString("mode").equals("original")
            ? "原始音频"
            : variant().equals("vocal") ? "原唱" : "伴奏";
    vocal.setSelected(variant().equals("vocal"));
    TvStyle.glyph(pause, paused() ? "play" : "pause", true);
    pause.setContentDescription(paused() ? "播放" : "暂停");
    lyricToggle.setSelected(lyricsVisible);
    lyricToggle.setContentDescription(lyricsVisible ? "隐藏歌词" : "显示歌词");
    title.setText(has ? current.optString("title") : "下一首，就唱你喜欢的");
    subtitle.setText(
        has
            ? current.optString("artist")
                + " · "
                + (current.optBoolean("ambient") ? "随机播放 · " : "")
                + voice
            : "点一首歌，开启今晚的好时光");
    long offset = playback.optLong("lyricsOffsetMs");
    offsetLabel.setText(
        offset == 0
            ? "歌词原始时间"
            : "歌词"
                + (offset > 0 ? "提前 " : "延后 ")
                + String.format(java.util.Locale.ROOT, "%.1f", Math.abs(offset) / 1000.0)
                + " 秒");
    updateAdjustmentVisibility();
    if (lastPaused != paused()) {
      lastPaused = paused();
      if (lastPaused) reveal(false);
      else armHide();
    }
  }

  @Override
  public void state(JSONObject state) {
    JSONObject room = state.optJSONObject("room");
    if (room != null) {
      String code = room.optString("code");
      roomCode = code;
      roomBadge.setText(code.isEmpty() ? "已连接 · NAS" : "歌房 " + code);
      roomBadge.setContentDescription("歌房号码 " + code);
      subtitle.setContentDescription("歌房号码 " + code);
      title.setOnLongClickListener(v -> {
        new AlertDialog.Builder(activity).setTitle("当前歌房 " + code)
            .setMessage("其他播放设备输入此号码加入后，可以接管播放。手机遥控请扫描歌房二维码。")
            .setPositiveButton("知道了", null).show();
        return true;
      });
    }
    JSONArray queue = state.optJSONArray("queue");
    queueCount = queue == null ? 0 : queue.length();
    JSONObject nextEntry = queueCount > 0 ? queue.optJSONObject(0) : state.optJSONObject("ambient");
    String before = current == null ? "" : current.optString("id"),
        after = nextEntry == null ? "" : nextEntry.optString("id");
    current = nextEntry;
    playback = state.optJSONObject("playback");
    if (playback == null) playback = new JSONObject();
    if (!before.equals(after)) {
      player.stop();
      mediaEntry = "";
      lastEnded = "";
      lyricBaseOffset = 0;
      error = "";
      lyrics.lyrics(new LyricsTimeline(""), 0, 0, 0xffffd66e, 48, "sans-serif");
      stageTitle.setVisibility(VISIBLE);
      stageTitle.setText(
          current == null
              ? "客厅的舞台，留给你"
              : current.optString("title") + "\n" + current.optString("artist"));
    }
    lyrics.offset(lyricBaseOffset + playback.optLong("lyricsOffsetMs") / 1000.0);
    queueButton.setText("已点歌曲  " + queueCount);
    catalogue.queue(state);
    overlay.queue(queue);
    updateControls();
    syncPlayback();
  }

  @Override
  public void media(String entry, JSONObject resources, boolean legacy) {
    if (current == null || !entry.equals(current.optString("id"))) return;
    mediaEntry = entry;
    error = "";
    send(
        RoomApi.object(
            "action",
            "load",
            "session",
            entry,
            "resources",
            resources,
            "legacy",
            legacy,
            "variant",
            variant()));
    stageTitle.setVisibility(resources.has("video") || legacy ? GONE : VISIBLE);
    syncPlayback();
  }

  @Override
  public void lyrics(String entry, LyricsTimeline timeline, JSONObject style, double offset) {
    if (current == null || !entry.equals(current.optString("id"))) return;
    lyricBaseOffset = offset + style.optDouble("offset", 0);
    int color = 0xffffd66e;
    try {
      color = Color.parseColor(style.optString("color", "#ffd66e"));
    } catch (IllegalArgumentException ignored) {
    }
    lyrics.lyrics(
        timeline,
        current.optDouble("duration"),
        lyricBaseOffset + playback.optLong("lyricsOffsetMs") / 1000.0,
        color,
        (float) style.optDouble("size", 48),
        style.optString("font", "sans-serif"));
    lyrics.position((float) style.optDouble("x", 50), (float) style.optDouble("y", 67));
  }

  @Override
  public void permission(boolean allowed) {
    boolean recovered = allowed && foreground && !lease;
    lease = allowed && foreground;
    if (recovered) {
      error = "";
      lastStatus = "";
      status.setVisibility(GONE);
    }
    syncPlayback();
  }

  private void syncPlayback() {
    if (mediaEntry.isEmpty()) return;
    send(
        RoomApi.object(
            "action",
            "state",
            "session",
            mediaEntry,
            "lease",
            lease,
            "paused",
            paused(),
            "variant",
            variant()));
    lyrics.refresh();
  }

  private void send(JSONObject value) {
    try {
      player.command(value);
    } catch (Exception failure) {
      error("播放参数无效，请重新连接歌房", false);
    }
  }

  private void nativeState(JSONObject value) {
    if (closed || !value.optString("session").equals(mediaEntry)) return;
    stats = value;
    if (lastNativePlaying != value.optBoolean("playing")) {
      lastNativePlaying = value.optBoolean("playing");
      lyrics.refresh();
    }
    String warning = value.optString("error", "");
    if (warning.isEmpty()) warning = value.optString("warning", "");
    if (!warning.isEmpty()) error(warning, false);
    else if (lease && error.isEmpty()) {
      status.setVisibility(GONE);
    }
    if (value.optBoolean("pictureError")) stageTitle.setVisibility(VISIBLE);
    if (value.optBoolean("ended") && lease && !paused() && !mediaEntry.equals(lastEnded)) {
      lastEnded = mediaEntry;
      session.command(
          "/api/player/ended",
          "POST",
          RoomApi.object("entryId", mediaEntry, "playerId", session.playerId),
          null);
    }
  }

  @Override
  public void error(String message, boolean auth) {
    if (closed) return;
    if (auth) {
      if (!authReported) {
        authReported = true;
        actions.authRequired();
      }
      return;
    }
    error = message;
    if (!message.equals(lastStatus)) {
      lastStatus = message;
      status.setText(message + "  ·  菜单键可重试");
      reveal(false);
    }
    status.setVisibility(VISIBLE);
  }

  void retry() {
    error = "";
    lastStatus = "";
    status.setVisibility(GONE);
    session.retry(current);
  }

  private void join() {
    session.read(
        "/api/join?origin=" + RoomApi.encode(session.api.server),
        value -> {
          try {
            JSONObject data = (JSONObject) value;
            String qr = data.getString("qr");
            byte[] bytes = Base64.decode(qr.substring(qr.indexOf(',') + 1), Base64.DEFAULT);
            ImageView image = new ImageView(activity);
            image.setAdjustViewBounds(true);
            image.setImageBitmap(BitmapFactory.decodeByteArray(bytes, 0, bytes.length));
            image.setPadding(dp(28), dp(20), dp(28), dp(20));
            dialogOpen = true;
            AlertDialog dialog =
                new AlertDialog.Builder(activity)
                    .setTitle("手机扫码点歌")
                    .setView(image)
                    .setPositiveButton("关闭", null)
                    .create();
            dialog.setOnDismissListener(
                d -> {
                  dialogOpen = false;
                  armHide();
                });
            dialog.show();
          } catch (Exception e) {
            error("二维码读取失败，请重试", false);
          }
        });
  }

  void diagnostics() {
    dialogOpen = true;
    AlertDialog dialog =
        new AlertDialog.Builder(activity)
            .setTitle("播放信息")
            .setMessage(
                "Media3 · SurfaceView · 原生歌词\n"
                    + stats.optInt("width")
                    + " × "
                    + stats.optInt("height")
                    + "  "
                    + stats.optDouble("fps", 0)
                    + " fps\n解码器："
                    + stats.optString("decoder", "等待播放")
                    + "\n丢帧："
                    + stats.optLong("droppedFrames")
                    + "\n缓冲："
                    + (stats.optLong("bufferedMs") / 1000)
                    + " 秒\n"
                    + session.api.server)
            .setPositiveButton("关闭", null)
            .create();
    dialog.setOnDismissListener(
        d -> {
          dialogOpen = false;
          armHide();
        });
    dialog.show();
  }

  void foreground(boolean value) {
    foreground = value;
    player.foreground(value);
    session.active(value);
    if (value) {
      lyrics.refresh();
      armHide();
    } else handler.removeCallbacks(hideControls);
  }

  @Override
  public void close() {
    closed = true;
    handler.removeCallbacksAndMessages(null);
    session.close();
    catalogue.close();
    overlay.close();
    player.destroy();
  }
}
