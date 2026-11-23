package home.haohaochang.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.LruCache;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.GridView;
import android.widget.FrameLayout;
import android.widget.AbsListView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.ProgressBar;
import java.util.concurrent.ExecutorService;
import org.json.JSONArray;
import org.json.JSONObject;

/** Recycled native grid. Decode thumbnails off the UI thread with a bounded bitmap cache. */
final class NativeCatalogue extends LinearLayout implements AutoCloseable {
  private final Activity activity;
  private final Context skin;
  private final RoomSession session;
  private final GridView grid;
  private final TextView heading, empty, description, breadcrumb;
  private boolean compact;
  private final EditText search;
  private final Cards adapter = new Cards();
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService images =
      new java.util.concurrent.ThreadPoolExecutor(
          2,
          2,
          0,
          java.util.concurrent.TimeUnit.SECONDS,
          new java.util.concurrent.ArrayBlockingQueue<>(32),
          new java.util.concurrent.ThreadPoolExecutor.DiscardOldestPolicy());
  private final LruCache<String, Bitmap> cache =
      new LruCache<String, Bitmap>(12 * 1024 * 1024) {
        protected int sizeOf(String key, Bitmap value) {
          return value.getAllocationByteCount();
        }
      };
  private JSONArray rows = new JSONArray();
  private String page = "songs", artist = "", tag = "", queueKey = "";
  private String playlistEntry = "";
  private int generation, onlinePage = 1;
  private boolean closed;
  private final Button more;
  private final Button find;
  private final Button sort, exact;
  private boolean randomOrder;
  private final LinearLayout query;
  private final LinearLayout results, catalogueTools;
  private final LinearLayout playlistTools;
  private final Button[] randomButtons = new Button[3];
  private final LinearLayout progressRow;
  private final TextView progressLabel;
  private final ProgressBar progressBar;
  private boolean progressLoading;
  private boolean exactSearch;
  private int keyboardColumns = 4;
  private int selectedPosition;
  private int songCoverHeight;
  private final LinearLayout initialsPanel;
  private final TextView initialLabel;
  private final java.util.List<Button> initialButtons = new java.util.ArrayList<>();
  private String initialQuery = "";

  NativeCatalogue(Activity activity, RoomSession session) {
    this(activity, session, activity);
  }

  NativeCatalogue(Activity activity, RoomSession session, Context skin) {
    super(skin);
    this.activity = activity;
    this.session = session;
    this.skin = skin;
    setOrientation(VERTICAL);
    setBackgroundColor(android.graphics.Color.TRANSPARENT);
    setPadding(dp(24), dp(16), dp(20), dp(12));
    breadcrumb = TvStyle.text(skin, "我的客厅    /    家庭 KTV", 9, TvStyle.MUTED);
    addView(breadcrumb, new LayoutParams(-1, dp(24)));
    heading = TvStyle.text(skin, "今晚，唱点开心的。", 26, TvStyle.INK);
    heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    addView(heading, new LayoutParams(-1, dp(42)));
    description = TvStyle.text(skin, "一首熟悉的旋律，一屋子喜欢的人。", 12, TvStyle.MUTED);
    addView(description, new LayoutParams(-1, dp(28)));
    query = new LinearLayout(activity);
    query.setGravity(Gravity.CENTER_VERTICAL);
    addView(query, new LayoutParams(-1, dp(46)));
    search = new EditText(skin);
    search.setSingleLine();
    search.setTextSize(16);
    TvStyle.textColor(search, TvStyle.INK);
    search.setHintTextColor(TvStyle.color(skin, TvStyle.MUTED));
    search.setHint("歌名 / 歌手 / 拼音首字母");
    search.setBackground(TvStyle.focus(skin));
    search.setContentDescription("搜索歌名或歌手");
    search.setPadding(dp(12), 0, dp(12), 0);
    search.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
    query.addView(search, new LayoutParams(0, -1, 1));
    find = TvStyle.button(skin, "搜索", "搜索", this::search);
    LayoutParams findParams = new LayoutParams(dp(72), -1);
    findParams.leftMargin = dp(10);
    query.addView(find, findParams);
    sort =
        TvStyle.button(
            skin,
            "歌名排序",
            "切换歌名排序或随机",
            () -> {
              randomOrder = !randomOrder;
              load();
            });
    TvStyle.subtle(sort);

    search.setOnEditorActionListener(
        (v, id, event) -> {
          if (id == EditorInfo.IME_ACTION_SEARCH) {
            search();
            return true;
          }
          return false;
        });
    progressRow = new LinearLayout(activity);
    progressRow.setGravity(Gravity.CENTER_VERTICAL);
    progressLabel = TvStyle.text(skin, "", 11, TvStyle.MUTED);
    progressLabel.setSingleLine();
    progressLabel.setEllipsize(TextUtils.TruncateAt.END);
    progressBar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
    progressBar.setMax(100);
    progressBar.setProgressTintList(ColorStateList.valueOf(TvStyle.color(skin, TvStyle.ACCENT)));
    progressRow.addView(progressLabel, new LayoutParams(0, -1, 1));
    progressRow.addView(progressBar, new LayoutParams(dp(100), dp(10)));
    progressRow.setContentDescription("当前找歌进度");
    addView(progressRow, new LayoutParams(-1, dp(28)));
    progressRow.setVisibility(GONE);
    songCoverHeight = dp(102);
    grid = new GridView(activity) {
      @Override
      protected void onMeasure(int widthSpec, int heightSpec) {
        int coverHeight = dp(102);
        if (!compact && (page.equals("songs") || page.equals("my-playlist"))
            && MeasureSpec.getMode(heightSpec) == MeasureSpec.EXACTLY) {
          int viewport = MeasureSpec.getSize(heightSpec) - getPaddingTop() - getPaddingBottom();
          int rowHeight = (viewport - getVerticalSpacing()) / 2;
          int captionHeight = dp(5) + dp(7) + dp(30) + dp(22) + dp(22);
          coverHeight = Math.max(dp(48), Math.min(coverHeight, rowHeight - captionHeight));
        }
        if (coverHeight != songCoverHeight) {
          songCoverHeight = coverHeight;
          adapter.notifyDataSetChanged();
        }
        super.onMeasure(widthSpec, heightSpec);
      }
    };
    grid.setId(View.generateViewId());
    grid.setFocusable(true);
    grid.setFocusableInTouchMode(true);
    grid.setContentDescription("歌曲卡片");
    grid.setNumColumns(GridView.AUTO_FIT);
    grid.setColumnWidth(dp(132));
    grid.setStretchMode(GridView.STRETCH_COLUMN_WIDTH);
    grid.setHorizontalSpacing(dp(12));
    grid.setVerticalSpacing(dp(8));
    grid.setClipToPadding(false);
    grid.setPadding(dp(3), dp(14), dp(3), dp(5));
    grid.setSelector(android.R.color.transparent);
    grid.setAdapter(adapter);
    grid.setOnFocusChangeListener((view, focused) -> highlightCards());
    grid.setOnItemClickListener(
        (parent, view, position, id) -> {
          selectedPosition = position;
          select(rows.optJSONObject(position));
        });
    grid.setOnItemLongClickListener(
        (parent, view, position, id) -> {
          selectedPosition = position;
          return deleteSelection();
        });
    results = new LinearLayout(activity);
    addView(results, new LayoutParams(-1, 0, 1));
    initialsPanel = new LinearLayout(activity);
    initialsPanel.setOrientation(VERTICAL);
    initialsPanel.setPadding(0, dp(14), dp(14), 0);
    results.addView(initialsPanel, new LayoutParams(dp(150), -1));
    initialLabel = TvStyle.text(skin, "拼音首字母", 12, TvStyle.MUTED);
    initialLabel.setSingleLine();
    initialsPanel.addView(initialLabel, new LayoutParams(-1, dp(28)));
    for (int row = 0; row < 7; row++) {
      LinearLayout line = new LinearLayout(activity);
      initialsPanel.addView(line, new LayoutParams(-1, dp(30)));
      for (int col = 0; col < 4; col++) {
        int index = row * 4 + col;
        String text = index < 26 ? String.valueOf((char) ('A' + index)) : index == 26 ? "←" : "清";
        Button button =
            TvStyle.button(
                skin,
                text,
                index < 26 ? "首字母 " + text : index == 26 ? "退格" : "清空",
                () -> {
                  initialQuery =
                      index < 26
                          ? (initialQuery + text)
                              .substring(0, Math.min(24, initialQuery.length() + 1))
                          : index == 26
                              ? initialQuery.substring(0, Math.max(0, initialQuery.length() - 1))
                              : "";
                  search.setText("");
                  load();
                });
        TvStyle.subtle(button);
        button.setTextSize(18);
        if (index == 27) TvStyle.iconOnly(button, "trash");
        button.setPadding(0, 0, 0, 0);
        initialButtons.add(button);
        line.addView(button, new LayoutParams(0, -1, 1));
      }
    }
    catalogueTools = new LinearLayout(activity);
    exact = TvStyle.button(skin, "", "精确搜索", () -> {
      exactSearch = !exactSearch;
      query.setVisibility(exactSearch ? VISIBLE : GONE);
      if (exactSearch) search.requestFocus();
    });
    TvStyle.iconOnly(exact, "search");
    TvStyle.iconOnly(sort, "sort");
    catalogueTools.addView(exact, new LayoutParams(0, -1, 1));
    catalogueTools.addView(sort, new LayoutParams(0, -1, 1));
    initialsPanel.addView(catalogueTools, new LayoutParams(-1, dp(38)));
    playlistTools = new LinearLayout(activity);
    playlistTools.setOrientation(VERTICAL);
    for (int i = 0; i < randomButtons.length; i++) {
      int count = (i + 1) * 10;
      String label = "随机点 " + count + " 首";
      Button button = TvStyle.button(skin, label, label, () -> enqueueRandom(count));
      TvStyle.subtle(button);
      button.setTextSize(12);
      randomButtons[i] = button;
      playlistTools.addView(button, new LayoutParams(-1, dp(42)));
    }
    results.addView(playlistTools, new LayoutParams(dp(150), -1));
    playlistTools.setVisibility(GONE);
    results.addView(grid, new LayoutParams(0, -1, 1));
    empty = TvStyle.text(skin, "正在读取…", 16, TvStyle.MUTED);
    empty.setGravity(Gravity.CENTER);
    empty.setSingleLine();
    empty.setEllipsize(TextUtils.TruncateAt.END);
    addView(empty, new LayoutParams(-1, dp(28)));
    grid.setEmptyView(empty);
    more =
        TvStyle.button(
            skin,
            "下一页",
            "下一页",
            () -> {
              onlinePage = Math.min(20, onlinePage + 1);
              load();
            });
    addView(more, new LayoutParams(-1, dp(38)));
    more.setVisibility(GONE);
  }

  private final Runnable progressPoll = new Runnable() {
    @Override public void run() {
      if (closed || progressLoading) return;
      if (!page.equals("online") || !isShown()) {
        progressRow.setVisibility(GONE);
        return;
      }
      progressLoading = true;
      session.read("/api/requests/status", value -> {
        progressLoading = false;
        if (closed) return;
        JSONObject task = value instanceof JSONArray ? ((JSONArray) value).optJSONObject(0) : null;
        if (!page.equals("online") || task == null) progressRow.setVisibility(GONE);
        else {
          String label = task.optString("message", "");
          if (label.isEmpty()) label = task.optString("progressLabel", "");
          if (label.isEmpty()) {
            String stage = task.optString("stage");
            label = stage.equals("downloading") ? "下载视频" : stage.equals("clipping") ? "裁剪视频"
                : task.optString("status").equals("queued") ? "等待处理" : "转换播放资源";
          }
          boolean known = !task.isNull("percent") && task.has("percent");
          int percent = Math.max(0, Math.min(100, task.optInt("percent")));
          progressLabel.setText(task.optString("title") + " · " + label + (known ? " " + percent + "%" : ""));
          progressBar.setIndeterminate(!known);
          if (known) progressBar.setProgress(percent);
          progressRow.setVisibility(VISIBLE);
        }
        main.removeCallbacks(this);
        main.postDelayed(this, 3000);
      }, true);
    }
  };

  void refreshAppearance() {
    TvAppearance appearance = TvAppearance.of(skin);
    int backdrop = appearance == null ? Color.TRANSPARENT : (appearance.page() & 0x00ffffff) | 0xcc000000;
    setBackgroundColor(backdrop);
    progressBar.setProgressTintList(ColorStateList.valueOf(TvStyle.color(skin, TvStyle.ACCENT)));
    grid.invalidateViews();
  }

  private int dp(float n) {
    return TvStyle.dp(activity, n);
  }

  void compact(boolean value) {
    if (compact == value) return;
    compact = value;
    setBackgroundColor(android.graphics.Color.TRANSPARENT);
    adapter.notifyDataSetChanged();
    requestLayout();
  }

  void show(String page) {
    this.page = page;
    exactSearch = false;
    artist = "";
    tag = "";
    initialQuery = "";
    search.setText("");
    onlinePage = 1;
    progressRow.setVisibility(GONE);
    main.removeCallbacks(progressPoll);
    main.post(progressPoll);
    load();
  }

  boolean back() {
    if (!artist.isEmpty() || !tag.isEmpty()) {
      show(!artist.isEmpty() ? "artists" : "playlists");
      grid.requestFocusFromTouch();
      return true;
    }
    return false;
  }

  void focusGrid() {
    if (rows.length() > 0) focusCard(selectedPosition);
    else focusSearch();
  }

  private void focusSearch() {
    if (query.isShown()) search.requestFocusFromTouch();
    else if (exact.isShown()) exact.requestFocusFromTouch();
    else if (playlistTools.isShown()) randomButtons[0].requestFocusFromTouch();
  }

  private void focusCard(int position) {
    selectedPosition = Math.max(0, Math.min(rows.length() - 1, position));
    if (!grid.hasFocus()) grid.requestFocusFromTouch();
    int first = grid.getFirstVisiblePosition();
    int columns = Math.max(1, grid.getNumColumns());
    View anchor = grid.getChildAt(0);
    if (anchor == null) {
      grid.setSelection(selectedPosition);
      grid.post(this::highlightCards);
      return;
    }
    View target = grid.getChildAt(selectedPosition - first);
    // All cards within a grid use the same height. Use the first attached row
    // to locate a target that has not been laid out yet.
    int rowOffset = selectedPosition / columns - first / columns;
    int targetTop = target != null ? target.getTop()
        : anchor.getTop() + rowOffset * (anchor.getHeight() + grid.getVerticalSpacing());
    int targetBottom = targetTop + (target != null ? target.getHeight() : anchor.getHeight());
    // The grid draws into its padding (clipToPadding=false). A card is fully
    // visible until it crosses the actual viewport edge, including that area.
    int delta = targetTop < 0 ? targetTop : Math.max(0, targetBottom - grid.getHeight());
    if (delta != 0) {
      int scrollLimit = grid.getHeight() - grid.getPaddingTop() - grid.getPaddingBottom() - 1;
      if (Math.abs(delta) > scrollLimit) grid.setSelection(selectedPosition);
      else grid.scrollListBy(delta);
      grid.post(this::highlightCards);
    }
    highlightCards();
  }

  private void highlightCards() {
    for (int i = 0; i < grid.getChildCount(); i++)
      grid.getChildAt(i)
          .setActivated(grid.hasFocus() && grid.getFirstVisiblePosition() + i == selectedPosition);
  }

  boolean activate(View target) {
    if (target != grid) return false;
    select(rows.optJSONObject(selectedPosition));
    return true;
  }

  /** GridView scrolling and selection are explicit even when the TV starts in touch mode. */
  boolean move(int key) {
    if (playlistTools.hasFocus()) {
      boolean horizontal = playlistTools.getOrientation() == HORIZONTAL;
      int previous = horizontal ? KeyEvent.KEYCODE_DPAD_LEFT : KeyEvent.KEYCODE_DPAD_UP;
      int next = horizontal ? KeyEvent.KEYCODE_DPAD_RIGHT : KeyEvent.KEYCODE_DPAD_DOWN;
      int enter = horizontal ? KeyEvent.KEYCODE_DPAD_DOWN : KeyEvent.KEYCODE_DPAD_RIGHT;
      int index = java.util.Arrays.asList(randomButtons).indexOf(findFocus());
      if (key == previous && index > 0) randomButtons[index - 1].requestFocusFromTouch();
      else if (key == next && index + 1 < randomButtons.length)
        randomButtons[index + 1].requestFocusFromTouch();
      else if (key == enter && rows.length() > 0) focusGrid();
      else return horizontal && key == next;
      return true;
    }
    if (catalogueTools.hasFocus()) {
      if (key == KeyEvent.KEYCODE_DPAD_UP) initialButtons.get(initialButtons.size() - 1).requestFocusFromTouch();
      else if (key == KeyEvent.KEYCODE_DPAD_DOWN) { focusGrid(); return rows.length() > 0; }
      else if (key == KeyEvent.KEYCODE_DPAD_LEFT) {
        if (sort.hasFocus()) exact.requestFocusFromTouch();
        else return false;
      } else if (key == KeyEvent.KEYCODE_DPAD_RIGHT) {
        if (exact.hasFocus() && sort.isShown()) sort.requestFocusFromTouch();
        else focusGrid();
      }
      return true;
    }
    if (initialsPanel.hasFocus()) {
      int index = initialButtons.indexOf(findFocus());
      if (key == KeyEvent.KEYCODE_DPAD_LEFT && index % keyboardColumns == 0) return false;
      if (key == KeyEvent.KEYCODE_DPAD_RIGHT && index % keyboardColumns == keyboardColumns - 1) {
        focusGrid();
        return true;
      }
      if (key == KeyEvent.KEYCODE_DPAD_UP && index < keyboardColumns) {
        if (query.isShown()) search.requestFocusFromTouch();
        return true;
      }
      int next =
          index
              + (key == KeyEvent.KEYCODE_DPAD_LEFT
                  ? -1
                  : key == KeyEvent.KEYCODE_DPAD_RIGHT
                      ? 1
                      : key == KeyEvent.KEYCODE_DPAD_UP ? -keyboardColumns : keyboardColumns);
      if (next >= initialButtons.size()) { exact.requestFocusFromTouch(); return true; }
      if (next >= 0) initialButtons.get(next).requestFocusFromTouch();
      return true;
    }
    if (grid.hasFocus()) {
      int position = selectedPosition;
      int columns = Math.max(1, grid.getNumColumns());
      if (key == KeyEvent.KEYCODE_DPAD_LEFT) {
        if (position % columns == 0) {
          if (playlistTools.isShown() && playlistTools.getOrientation() == VERTICAL) {
            randomButtons[0].requestFocusFromTouch();
            return true;
          }
          if (initialsPanel.isShown()) {
            initialButtons.get(keyboardColumns - 1).requestFocusFromTouch();
            return true;
          }
          return false;
        }
        focusCard(position - 1);
      } else if (key == KeyEvent.KEYCODE_DPAD_RIGHT) {
        if (position % columns < columns - 1 && position + 1 < rows.length())
          focusCard(position + 1);
      } else if (key == KeyEvent.KEYCODE_DPAD_UP) {
        if (position < columns) focusSearch();
        else focusCard(position - columns);
      } else if (key == KeyEvent.KEYCODE_DPAD_DOWN) {
        if (position + columns >= rows.length()) {
          if (more.isShown()) more.requestFocusFromTouch();
          else return false;
        } else focusCard(position + columns);
      }
      return true;
    }
    if (key == KeyEvent.KEYCODE_DPAD_DOWN) {
      if (rows.length() == 0 || more.hasFocus()) return false;
      focusCard(0);
    } else if (key == KeyEvent.KEYCODE_DPAD_UP && more.hasFocus()) focusCard(rows.length() - 1);
    else if (key == KeyEvent.KEYCODE_DPAD_LEFT) {
      if (sort.hasFocus()) find.requestFocusFromTouch();
      else if (find.hasFocus()) search.requestFocusFromTouch();
      else return false;
    } else if (key == KeyEvent.KEYCODE_DPAD_RIGHT && search.hasFocus())
      find.requestFocusFromTouch();
    else if (key == KeyEvent.KEYCODE_DPAD_RIGHT && find.hasFocus() && sort.isShown())
      sort.requestFocusFromTouch();
    return true;
  }

  private void search() {
    initialQuery = "";
    onlinePage = 1;
    load();
    android.view.inputmethod.InputMethodManager keyboard =
        (android.view.inputmethod.InputMethodManager)
            activity.getSystemService(Activity.INPUT_METHOD_SERVICE);
    if (keyboard != null) keyboard.hideSoftInputFromWindow(search.getWindowToken(), 0);
  }

  private void load() {
    boolean playlist = page.equals("my-playlist");
    sort.setVisibility(page.equals("songs") || !artist.isEmpty() ? VISIBLE : GONE);
    sort.setContentDescription("切换歌名排序或随机");
    sort.setSelected(randomOrder);
    initialsPanel.setVisibility(getWidth() >= dp(540) && (page.equals("songs") || page.equals("artists")) ? VISIBLE : GONE);
    playlistTools.setVisibility(playlist ? VISIBLE : GONE);
    query.setVisibility(playlist || page.equals("queue") || ((page.equals("songs") || page.equals("artists")) && !exactSearch) ? GONE : VISIBLE);
    initialLabel.setText(initialQuery.isEmpty() ? "拼音首字母" : initialQuery);
    int request = ++generation;
    selectedPosition = 0;
    queueKey = "";
    more.setVisibility(GONE);
    rows = new JSONArray();
    adapter.notifyDataSetChanged();
    empty.setText("正在读取…");
    heading.setText(
        !artist.isEmpty()
            ? artist
            : !tag.isEmpty()
                ? tag + "歌单"
                : page.equals("artists")
                    ? "歌星点歌"
                    : page.equals("playlists")
                        ? "分类歌单"
                        : page.equals("queue")
                            ? "已点歌曲"
                            : playlist ? "我的歌单" : page.equals("online") ? "在线找歌" : "歌名点歌");
    description.setText(
        page.equals("artists")
            ? "从喜欢的歌手，找到想唱的那一首。"
            : page.equals("queue")
                ? "今晚的歌单，按你的顺序唱。"
                : page.equals("online")
                    ? "找一首喜欢的歌，交给歌房准备。"
                    : playlist
                        ? "本歌房唱完的歌曲，按演唱次数排列。"
                        : page.equals("playlists") ? "换一种心情，发现下一首。" : "一首熟悉的旋律，一屋子喜欢的人。");
    search.setHint(page.equals("online") ? "输入歌名，搜索在线资源" : "歌名 / 歌手 / 拼音首字母");
    if (playlist) {
      readPlaylist(request);
      return;
    }
    if (page.equals("queue")) {
      session.read(
          "/api/state",
          value -> {
            if (request == generation) queue((JSONObject) value);
          });
      return;
    }
    if (page.equals("playlists") && tag.isEmpty()) {
      JSONArray tags = new JSONArray();
      for (String text :
          new String[] {
            "男声", "女声", "组合", "合唱", "大陆", "港台", "欧美", "日韩", "国语", "粤语", "英语", "日语", "韩语", "流行",
            "摇滚", "怀旧", "现场", "MV", "伴奏"
          }) tags.put(RoomApi.object("tag", text, "title", text));
      setRows(tags);
      return;
    }
    if (page.equals("online") && search.getText().toString().trim().isEmpty()) {
      setRows(new JSONArray());
      empty.setText("输入歌名搜索；选择结果后可加入下载与点歌任务。");
      return;
    }
    String path =
        page.equals("artists") && artist.isEmpty()
            ? "/api/artists?q="
                + RoomApi.encode(search.getText().toString())
                + "&initials="
                + RoomApi.encode(initialQuery)
            : page.equals("online")
                ? "/api/online/songs?title="
                    + RoomApi.encode(search.getText().toString())
                    + "&page="
                    + onlinePage
                : "/api/songs?q="
                    + RoomApi.encode(search.getText().toString())
                    + "&artist="
                    + RoomApi.encode(artist)
                    + "&tag="
                    + RoomApi.encode(tag)
                    + "&initials="
                    + RoomApi.encode(initialQuery)
                    + "&sort="
                    + (randomOrder ? "random" : "title");
    session.read(
        path,
        value -> {
          if (request != generation) return;
          JSONArray result =
              value instanceof JSONArray
                  ? (JSONArray) value
                  : ((JSONObject) value).optJSONArray("items");
          if (result == null && value instanceof JSONObject)
            result = ((JSONObject) value).optJSONArray("results");
          if (result == null) result = new JSONArray();
          setRows(result);
          more.setVisibility(
              page.equals("online")
                      && onlinePage < 20
                      && value instanceof JSONObject
                      && ((JSONObject) value).optBoolean("hasMore")
                  ? VISIBLE
                  : GONE);
        });
  }

  void queue(JSONObject state) {
    JSONArray queue = state.optJSONArray("queue");
    JSONObject first = queue == null ? null : queue.optJSONObject(0);
    String entry = first == null ? "" : first.optString("id");
    if (page.equals("my-playlist") && !entry.equals(playlistEntry)) readPlaylist(++generation);
    playlistEntry = entry;
    if (!page.equals("queue")) return;
    if (queue == null) queue = new JSONArray();
    String key = queue.toString();
    if (!key.equals(queueKey)) {
      queueKey = key;
      setRows(queue);
    }
  }

  private void setRows(JSONArray value) {
    boolean focused = grid.hasFocus();
    rows = value;
    adapter.notifyDataSetChanged();
    if (focused && rows.length() > 0) focusCard(selectedPosition);
    empty.setText(
        rows.length() > 0
            ? ""
            : page.equals("my-playlist")
                ? "点一首歌完整唱完，它就会出现在这里。"
                : "暂无歌曲，可在 NAS 管理端导入或整理。");
  }

  private void readPlaylist(int request) {
    session.read("/api/playlist", value -> {
      if (request != generation || !(value instanceof JSONArray)) return;
      JSONArray result = (JSONArray) value;
      if (result.toString().equals(rows.toString()) && rows.length() > 0) return;
      JSONObject selected = rows.optJSONObject(selectedPosition);
      if (selected != null) {
        String id = selected.optString("id");
        for (int i = 0; i < result.length(); i++) {
          if (id.equals(result.optJSONObject(i).optString("id"))) {
            selectedPosition = i;
            break;
          }
        }
      }
      setRows(result);
    });
  }

  private void enqueueRandom(int count) {
    if (rows.length() == 0) {
      android.widget.Toast.makeText(activity, "歌单还没有歌曲", android.widget.Toast.LENGTH_SHORT)
          .show();
      return;
    }
    session.command(
        "/api/queue/random",
        "POST",
        RoomApi.object("count", count, "name", "电视点歌"),
        value -> {
          int added = ((JSONObject) value).optInt("added");
          android.widget.Toast.makeText(
                  activity,
                  added > 0 ? "已随机加入 " + added + " 首歌曲" : "没有可加入的歌曲",
                  android.widget.Toast.LENGTH_SHORT)
              .show();
        });
  }

  private void select(JSONObject row) {
    if (row == null) return;
    if (row.has("tag")) {
      tag = row.optString("tag");
      load();
      return;
    }
    if (page.equals("artists") && artist.isEmpty()) {
      artist = row.optString("artist");
      initialQuery = "";
      search.setText("");
      load();
      return;
    }
    if (page.equals("queue")) {
      session.command(
          "/api/queue/" + RoomApi.encode(row.optString("id")) + "/top",
          "POST",
          new JSONObject(),
          null);
      return;
    }
    if (page.equals("online")) {
      online(row);
      return;
    }
    session.command(
        "/api/queue",
        "POST",
        RoomApi.object("songId", row.optString("id"), "name", "电视点歌"),
        value -> {
          boolean preparing = ((JSONObject) value).optBoolean("preparing");
          android.widget.Toast.makeText(
                  activity,
                  preparing ? "正在准备，完成后自动加入队列" : "已加入点歌队列",
                  android.widget.Toast.LENGTH_SHORT)
              .show();
        });
  }

  boolean longActivate(View target) {
    return target == grid && deleteSelection();
  }

  private boolean deleteSelection() {
    if (!page.equals("queue")) return false;
    JSONObject row = rows.optJSONObject(selectedPosition);
    if (row == null) return false;
    String id = row.optString("id");
    boolean current = selectedPosition == 0;
    new AlertDialog.Builder(activity)
        .setTitle(row.optString("title"))
        .setItems(
            new String[] {current ? "删除并切歌" : "删除歌曲"},
            (dialog, which) -> {
              if (current)
                session.command(
                    "/api/control", "POST", RoomApi.object("action", "next", "entryId", id), null);
              else session.command("/api/queue/" + RoomApi.encode(id), "DELETE", null, null);
            })
        .setNegativeButton("取消", null)
        .show();
    return true;
  }

  private void online(JSONObject row) {
    LinearLayout form = new LinearLayout(activity);
    form.setOrientation(VERTICAL);
    form.setPadding(dp(20), dp(12), dp(20), 0);
    EditText title = new EditText(activity);
    title.setSingleLine();
    title.setHint("歌名");
    title.setText(search.getText());
    form.addView(title);
    EditText singer = new EditText(activity);
    singer.setSingleLine();
    singer.setHint("歌手（必填）");
    form.addView(singer);
    AlertDialog dialog =
        new AlertDialog.Builder(activity)
            .setTitle("准备在线歌曲")
            .setMessage(row.optString("title"))
            .setView(form)
            .setNegativeButton("取消", null)
            .setPositiveButton("准备并点歌", null)
            .create();
    dialog.setOnShowListener(
        d ->
            dialog
                .getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(
                    v -> {
                      if (title.getText().toString().trim().isEmpty()) {
                        title.setError("请填写歌名");
                        return;
                      }
                      if (singer.getText().toString().trim().isEmpty()) {
                        singer.setError("请填写歌手");
                        return;
                      }
                      session.command(
                          "/api/online",
                          "POST",
                          RoomApi.object(
                              "url",
                              row.optString("url"),
                              "title",
                              title.getText().toString().trim(),
                              "artist",
                              singer.getText().toString().trim(),
                              "name",
                              "电视点歌",
                              "enqueue",
                              true,
                              "onlineSelection",
                              true,
                              "client",
                              "mobile"),
                          value ->
                              android.widget.Toast.makeText(
                                      activity, "已提交准备任务", android.widget.Toast.LENGTH_SHORT)
                                  .show());
                      dialog.dismiss();
                    }));
    dialog.show();
  }

  private final class Cards extends BaseAdapter {
    public int getViewTypeCount() { return 2; }

    public int getItemViewType(int position) {
      return page.equals("artists") && artist.isEmpty() ? 1 : 0;
    }

    public int getCount() {
      return rows.length();
    }

    public Object getItem(int position) {
      return rows.optJSONObject(position);
    }

    public long getItemId(int position) {
      return position;
    }

    public View getView(int position, View convert, ViewGroup parent) {
      if (getItemViewType(position) == 1) return artistView(position, convert);
      LinearLayout card;
      ImageView image;
      TextView title, detail, action;
      if (convert == null) {
        card = new LinearLayout(skin);
        card.setOrientation(VERTICAL);
        card.setPadding(dp(5), dp(5), dp(5), dp(7));
        card.setBackground(TvStyle.card(skin));
        card.setElevation(dp(2));
        image = new ImageView(activity);
        image.setScaleType(ImageView.ScaleType.CENTER_CROP);
        image.setClipToOutline(true);
        card.addView(image, new LayoutParams(-1, dp(102)));
        title = TvStyle.text(skin, "", 13, TvStyle.INK);
        title.setMaxLines(1);
        title.setEllipsize(TextUtils.TruncateAt.END);
        title.setPadding(dp(5), dp(8), dp(5), 0);
        card.addView(title, new LayoutParams(-1, dp(30)));
        detail = TvStyle.text(skin, "", 10, TvStyle.MUTED);
        detail.setSingleLine();
        detail.setEllipsize(TextUtils.TruncateAt.END);
        detail.setPadding(dp(5), 0, dp(5), 0);
        card.addView(detail, new LayoutParams(-1, dp(22)));
        action = TvStyle.text(skin, "＋ 点歌", 10, TvStyle.ACCENT);
        action.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        action.setPadding(dp(5), 0, dp(6), 0);
        card.addView(action, new LayoutParams(-1, dp(22)));
        card.setTag(new Object[] {image, title, detail, action});
        title.setDuplicateParentStateEnabled(true);
        detail.setDuplicateParentStateEnabled(true);
        action.setDuplicateParentStateEnabled(true);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
      } else {
        card = (LinearLayout) convert;
        Object[] views = (Object[]) card.getTag();
        image = (ImageView) views[0];
        title = (TextView) views[1];
        detail = (TextView) views[2];
        action = (TextView) views[3];
      }
      JSONObject row = rows.optJSONObject(position);
      card.setPadding(dp(compact ? 4 : 5), dp(compact ? 4 : 5), dp(compact ? 4 : 5), dp(compact ? 6 : 7));
      title.setTextSize(compact ? 12 : 13);
      title.setPadding(dp(5), dp(compact ? 4 : 8), dp(5), 0);
      title.setLayoutParams(new LayoutParams(-1, dp(compact ? 24 : 30)));
      detail.setLayoutParams(new LayoutParams(-1, dp(compact ? 18 : 22)));
      action.setVisibility(compact ? GONE : VISIBLE);
      card.setActivated(grid.hasFocus() && position == selectedPosition);
      boolean artistCard = page.equals("artists") && artist.isEmpty();
      action.setText(
          artistCard
              ? "查看歌曲  ›"
              : row.has("tag") ? "打开歌单  ›" : page.equals("queue") ? "点击优先" : "＋ 点歌");
      LayoutParams imageParams =
          new LayoutParams(-1,
              compact
                  ? Math.max(dp(68), Math.min(dp(112), (grid.getColumnWidth() - dp(8)) * 9 / 16)) : songCoverHeight);
      imageParams.gravity = Gravity.CENTER_HORIZONTAL;
      imageParams.topMargin = 0;
      imageParams.bottomMargin = 0;
      image.setLayoutParams(imageParams);
      GradientDrawable cover =
          new GradientDrawable(
              GradientDrawable.Orientation.TL_BR, new int[] {0xff44345d, 0xff241e31});
      cover.setCornerRadius(dp(8));
      image.setBackground(cover);
      title.setText(artistCard ? row.optString("artist") : row.optString("title"));
      detail.setText(
          artistCard
              ? row.optInt("count") + " 首歌曲"
              : row.has("tag")
                  ? "按此分类点歌"
                  : page.equals("queue")
                      ? (position == 0 ? "正在播放 · " : "待唱 · ") + row.optString("artist")
                      : row.optString("artist", row.optString("author", ""))
                          + (page.equals("my-playlist") ? " · 唱过 " + row.optInt("plays") + " 次" : ""));
      card.setContentDescription(title.getText() + "，" + detail.getText());
      bindImage(image, row, artistCard);
      return card;
    }

    private View artistView(int position, View convert) {
      FrameLayout card;
      ImageView image;
      TextView title, detail;
      if (convert == null) {
        card = new FrameLayout(skin);
        card.setBackground(TvStyle.shape(skin, TvStyle.SURFACE, 12));
        card.setClipToOutline(true);
        card.setForeground(TvStyle.photoCardOutline(skin));
        image = new ImageView(activity);
        card.addView(image, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout caption = new LinearLayout(activity);
        caption.setOrientation(VERTICAL);
        caption.setPadding(dp(9), dp(25), dp(9), dp(8));
        caption.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] {0x00160e22, 0xee160e22}));
        title = TvStyle.text(activity, "", 13, TvStyle.INK);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setSingleLine();
        title.setEllipsize(TextUtils.TruncateAt.END);
        detail = TvStyle.text(skin, "", 10, 0xffd4c3e0);
        detail.setSingleLine();
        caption.addView(title, new LayoutParams(-1, -2));
        caption.addView(detail, new LayoutParams(-1, -2));
        card.addView(caption, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        card.setTag(new Object[] {image, title, detail});
      } else {
        card = (FrameLayout) convert;
        Object[] views = (Object[]) card.getTag();
        image = (ImageView) views[0];
        title = (TextView) views[1];
        detail = (TextView) views[2];
      }
      int width = Math.max(grid.getColumnWidth(), dp(120));
      // GridView is already measuring this recycled row. Requesting another
      // parent layout here would keep restarting its layout pass.
      ViewGroup.LayoutParams cardParams = card.getLayoutParams();
      if (cardParams == null)
        card.setLayoutParams(new AbsListView.LayoutParams(-1, width * 2 / 3));
      else cardParams.height = width * 2 / 3;
      card.setActivated(grid.hasFocus() && position == selectedPosition);
      JSONObject row = rows.optJSONObject(position);
      title.setText(row.optString("artist"));
      title.setTextSize(compact ? 12 : 13);
      detail.setText(row.optInt("count") + " 首歌曲");
      card.setContentDescription(title.getText() + "，" + detail.getText());
      bindImage(image, row, true);
      return card;
    }

    private void bindImage(ImageView image, JSONObject row, boolean artistCard) {
      String path =
          page.equals("online")
              ? onlineCoverPath(row)
              : artistCard && row.optBoolean("hasPhoto")
              ? "/api/artist-photo/"
                  + RoomApi.encode(row.optString("id"))
                  + "?v="
                  + RoomApi.encode(row.optString("photoVersion"))
              : row.optInt("hasPoster") > 0
                  ? "/api/poster/"
                      + RoomApi.encode(row.optString("song_id", row.optString("id")))
                      + "?v="
                      + RoomApi.encode(row.optString("posterVersion"))
                  : "";
      image.setTag(path);
      image.setImageDrawable(
          new TvIcon(
              activity, artistCard ? "users" : "record", ColorStateList.valueOf(0xffac9cbe), 38));
      image.setScaleType(ImageView.ScaleType.CENTER);
      if (!path.isEmpty()) {
        Bitmap found = cache.get(path);
        if (found != null) {
          image.setScaleType(ImageView.ScaleType.CENTER_CROP);
          image.setImageBitmap(found);
        } else {
          final ImageView target = image;
          images.execute(
              () -> {
                try {
                  byte[] data = session.api.bytes(path, "GET", null, 8 * 1024 * 1024);
                  BitmapFactory.Options options = new BitmapFactory.Options();
                  options.inJustDecodeBounds = true;
                  BitmapFactory.decodeByteArray(data, 0, data.length, options);
                  options.inJustDecodeBounds = false;
                  options.inSampleSize = 1;
                  while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 512)
                    options.inSampleSize *= 2;
                  Bitmap bitmap = BitmapFactory.decodeByteArray(data, 0, data.length, options);
                  if (bitmap != null) {
                    cache.put(path, bitmap);
                    main.post(
                        () -> {
                          if (!closed && path.equals(target.getTag())) {
                            target.setScaleType(ImageView.ScaleType.CENTER_CROP);
                            target.setImageBitmap(bitmap);
                          }
                        });
                  }
                } catch (Exception ignored) {
                }
              });
        }
      }
    }
  }

  @Override
  public void close() {
    closed = true;
    generation++;
    images.shutdownNow();
    main.removeCallbacksAndMessages(null);
    cache.evictAll();
  }

  @Override
  protected void onMeasure(int widthSpec, int heightSpec) {
    boolean narrow = compact || MeasureSpec.getSize(widthSpec) < dp(540);
    setPadding(dp(compact ? 10 : 24), dp(compact ? 8 : 16), dp(compact ? 10 : 20), dp(compact ? 4 : 12));
    breadcrumb.setVisibility(compact || page.equals("online") ? GONE : VISIBLE);
    description.setVisibility(compact || page.equals("online") ? GONE : VISIBLE);
    heading.setVisibility(page.equals("online") || (compact && artist.isEmpty() && tag.isEmpty() && !page.equals("my-playlist")) ? GONE : VISIBLE);
    heading.setTextSize(compact ? 14 : 22);
    heading.getLayoutParams().height = dp(compact ? 28 : 34);
    boolean portrait = compact && MeasureSpec.getSize(widthSpec) < MeasureSpec.getSize(heightSpec);
    boolean catalogue = page.equals("songs") || page.equals("artists");
    initialsPanel.setVisibility(catalogue ? VISIBLE : GONE);
    results.setOrientation(portrait ? VERTICAL : HORIZONTAL);
    initialsPanel.setLayoutParams(new LayoutParams(portrait ? -1 : dp(compact ? 112 : 150), portrait ? dp(186) : -1));
    initialsPanel.setPadding(0, 0, portrait ? 0 : dp(8), 0);
    if (playlistTools.getVisibility() == VISIBLE) {
      int orientation = portrait ? HORIZONTAL : VERTICAL;
      if (playlistTools.getOrientation() != orientation) {
        playlistTools.setOrientation(orientation);
        for (Button button : randomButtons)
          button.setLayoutParams(
              portrait ? new LayoutParams(0, -1, 1) : new LayoutParams(-1, dp(42)));
      }
      playlistTools.setLayoutParams(
          new LayoutParams(portrait ? -1 : dp(compact ? 112 : 150), portrait ? dp(42) : -1));
      playlistTools.setPadding(0, 0, portrait ? 0 : dp(8), 0);
    }
    grid.setLayoutParams(portrait ? new LayoutParams(-1, 0, 1) : new LayoutParams(0, -1, 1));
    int columns = portrait ? 7 : 4;
    if (columns != keyboardColumns) {
      for (Button key : initialButtons) ((ViewGroup) key.getParent()).removeView(key);
      initialsPanel.removeViews(1, initialsPanel.getChildCount() - 2);
      for (int offset = 0; offset < initialButtons.size(); offset += columns) {
        LinearLayout line = new LinearLayout(activity);
        initialsPanel.addView(line, initialsPanel.getChildCount() - 1, new LayoutParams(-1, dp(30)));
        for (int i = offset; i < Math.min(offset + columns, initialButtons.size()); i++)
          line.addView(initialButtons.get(i), new LayoutParams(0, -1, 1));
      }
      keyboardColumns = columns;
    }
    query.getLayoutParams().height = dp(compact ? 40 : 46);
    search.setTextSize(compact ? 12 : narrow ? 13 : 16);
    find.setTextSize(compact ? 12 : 14);
    sort.setTextSize(compact ? 11 : 14);

    find.getLayoutParams().width = dp(compact ? 44 : narrow ? 48 : 72);
    ((LayoutParams) find.getLayoutParams()).leftMargin = dp(compact ? 6 : 10);
    grid.setHorizontalSpacing(dp(compact ? 8 : 12));
    grid.setVerticalSpacing(dp(8));
    grid.setPadding(dp(2), dp(compact ? 10 : 14), dp(2), dp(4));
    super.onMeasure(widthSpec, heightSpec);
  }

  static String onlineCoverPath(JSONObject row) {
    String path = row.optString("coverPath");
    if (path.startsWith("/api/online/cover?")) return path;
    String cover = row.optString("cover");
    if (cover.startsWith("//")) cover = "https:" + cover;
    if (cover.startsWith("http:")) cover = "https:" + cover.substring(5);
    return cover.isEmpty() ? "" : "/api/online/cover?url=" + RoomApi.encode(cover);
  }
}
