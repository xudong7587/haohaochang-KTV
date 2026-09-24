package home.haohaochang.tv;

import static org.junit.Assert.*;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.GridView;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, qualifiers = "w960dp-h540dp-land-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class NativeRoomTest {
  private Activity activity;
  private NativeRoom room;
  private LocalNas server;
  private final List<String> paths = new CopyOnWriteArrayList<>();
  private final List<JSONObject> commands = new CopyOnWriteArrayList<>();
  private volatile String songsFixture =
      "[{\"id\":\"song-1\",\"title\":\"测试歌曲\",\"artist\":\"测试歌手\"}]";
  private volatile String artistsFixture = "[]";
  private final JSONObject song =
      RoomApi.object(
          "id",
          "entry-1",
          "song_id",
          "song-1",
          "title",
          "测试歌曲",
          "artist",
          "测试歌手",
          "mode",
          "tracks",
          "duration",
          60);

  @Before
  public void setup() throws Exception {
    server =
        new LocalNas(
            (path, headers, body) -> {
              paths.add(path);
              if (path.equals("/api/control")) commands.add(new JSONObject(body));
              return new LocalNas.Reply(200, path.startsWith("/api/songs") ? songsFixture : path.startsWith("/api/artists") ? artistsFixture : "{}");
            });
    activity = Robolectric.buildActivity(Activity.class).setup().get();
    room =
        new NativeRoom(
            activity,
            new RoomApi(server.origin(), "fixture"),
            new NativeRoom.Actions() {
              public void settings() {}

              public void authRequired() {
                fail("unexpected auth error");
              }
            },
            false);
    activity.setContentView(room);
    room.state(
        RoomApi.object(
            "queue",
            new JSONArray().put(song),
            "playback",
            RoomApi.object("paused", false, "vocal", false, "lyricsOffsetMs", 0)));
    layout(960, 540);
    room.focusInitial();
  }

  @After
  public void cleanup() throws Exception {
    room.close();
    activity.finish();
    server.close();
  }

  private void layout(int width, int height) {
    room.measure(
        View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
    room.layout(0, 0, width, height);
  }

  private List<View> descendants(View root) {
    List<View> all = new ArrayList<>();
    all.add(root);
    if (root instanceof ViewGroup)
      for (int i = 0; i < ((ViewGroup) root).getChildCount(); i++)
        all.addAll(descendants(((ViewGroup) root).getChildAt(i)));
    return all;
  }

  private View find(String label) {
    return descendants(room).stream()
        .filter(
            v ->
                label.contentEquals(
                    v.getContentDescription() == null ? "" : v.getContentDescription()))
        .findFirst()
        .orElseThrow(() -> new AssertionError(label));
  }

  private void press(int key) {
    activity.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, key));
    activity.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, key));
  }

  @Test
  public void sidebarQrAndSettingsAlignWithGapAfterRelayout() {
    for (int[] size : new int[][] {{960, 540}, {1280, 800}, {960, 540}}) {
      layout(size[0], size[1]);
      layout(size[0], size[1]);
      View settings = find("设置");
      ViewGroup overlay = (ViewGroup) find("扫码点歌与已点歌单");
      View card = overlay.getChildAt(0);
      assertEquals(settings.getLeft(), overlay.getLeft() + card.getLeft());
      assertEquals(settings.getWidth(), card.getWidth());
      assertTrue(settings.getTop() - overlay.getBottom() >= 12);
      View parent = (View) settings.getParent();
      assertEquals(34, settings.getHeight());
      assertTrue(settings.getBottom() <= parent.getHeight() - parent.getPaddingBottom());
      Bitmap screenshot = Bitmap.createBitmap(size[0], size[1], Bitmap.Config.ARGB_8888);
      room.draw(new Canvas(screenshot));
      java.io.File folder = new java.io.File("build/test-screenshots");
      folder.mkdirs();
      try (java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(folder, "sidebar-aligned-" + size[0] + ".png"))) {
        screenshot.compress(Bitmap.CompressFormat.PNG, 100, out);
      } catch (java.io.IOException failure) { throw new AssertionError(failure); }
    }
  }

  @Test
  public void artistPhotoFillsCardAcrossPhoneRotationsAndTv() throws Exception {
    artistsFixture = "[{\"id\":\"artist-1\",\"artist\":\"测试歌手\",\"count\":12,\"hasPhoto\":true,\"photoVersion\":\"fixture\"}]";
    NativeCatalogue catalogue = (NativeCatalogue) descendants(room).stream()
        .filter(v -> v instanceof NativeCatalogue).findFirst().get();
    java.lang.reflect.Field field = NativeCatalogue.class.getDeclaredField("cache");
    field.setAccessible(true);
    @SuppressWarnings("unchecked")
    android.util.LruCache<String, Bitmap> cache = (android.util.LruCache<String, Bitmap>) field.get(catalogue);
    Bitmap portrait = Bitmap.createBitmap(160, 240, Bitmap.Config.ARGB_8888);
    portrait.eraseColor(0xff318ac7);
    cache.put("/api/artist-photo/artist-1?v=fixture", portrait);
    find("歌星点歌").performClick();
    drain();
    for (int[] size : new int[][] {{390,844},{844,390},{960,540}}) {
      layout(size[0], size[1]);
      layout(size[0], size[1]);
      GridView grid = (GridView) find("歌曲卡片");
      assertEquals(1, grid.getAdapter().getCount());
      ViewGroup card = (ViewGroup) grid.getChildAt(0);
      android.widget.ImageView image = (android.widget.ImageView) card.getChildAt(0);
      assertEquals(0, image.getLeft());
      assertEquals(0, image.getTop());
      assertEquals(card.getWidth(), image.getWidth());
      assertEquals(card.getHeight(), image.getHeight());
      assertEquals(android.widget.ImageView.ScaleType.CENTER_CROP, image.getScaleType());
      assertTrue(Math.abs(card.getWidth() / (double) card.getHeight() - 1.5) < .06);
      Bitmap screenshot = Bitmap.createBitmap(size[0], size[1], Bitmap.Config.ARGB_8888);
      room.draw(new Canvas(screenshot));
      java.io.File folder = new java.io.File("build/test-screenshots");
      folder.mkdirs();
      try (java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(folder, "artist-filled-" + size[0] + ".png"))) {
        screenshot.compress(Bitmap.CompressFormat.PNG, 100, out);
      }
    }
  }

  @Test
  public void remoteMovesAcrossSidebarContentAndFooterWithoutTouch() throws Exception {
    assertTrue(find("音乐现场").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    assertTrue(find("歌名点歌").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    assertTrue(find("歌星点歌").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_UP);
    assertTrue(find("歌名点歌").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_CENTER);
    drain();
    layout(960, 540);
    assertTrue(find("歌名点歌").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    assertTrue(find("歌曲卡片").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_UP);
    assertTrue(find("精确搜索").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_CENTER);
    layout(960, 540);
    assertTrue(find("搜索歌名或歌手").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    assertTrue(find("搜索").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_LEFT);
    assertTrue(find("搜索歌名或歌手").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    assertTrue(find("歌曲卡片").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_LEFT);
    assertTrue(find("首字母 D").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_LEFT);
    press(KeyEvent.KEYCODE_DPAD_LEFT);
    press(KeyEvent.KEYCODE_DPAD_LEFT);
    press(KeyEvent.KEYCODE_DPAD_LEFT);
    assertTrue(find("歌名点歌").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    assertTrue(find("暂停").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    assertTrue(find("切歌").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_LEFT);
    assertTrue(find("暂停").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_UP);
    assertTrue(find("歌曲卡片").hasFocus());
    assertEquals(0, commands.size());
  }

  @Test
  public void remoteConfirmActivatesOnceAndFullControlsStayNavigable() throws Exception {
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    assertTrue(find("暂停").hasFocus());
    activity.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_CENTER));
    activity.dispatchKeyEvent(
        new KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_CENTER, 3));
    activity.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_CENTER));
    drain();
    assertEquals(1, commands.size());
    assertEquals("pause", commands.get(0).optString("action"));
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    assertTrue(find("全屏播放").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_CENTER);
    layout(960, 540);
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    assertTrue(find("暂停").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_LEFT);
    assertTrue(find("切换原唱伴奏").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_LEFT);
    assertTrue(find("歌词延后 0.5 秒").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_UP);
    assertTrue(find("重置歌词微调").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    assertTrue(find("暂停").hasFocus());
  }

  @Test
  public void catalogueCoversMainStageAndCapturesNativeStyle() throws Exception {
    JSONArray fixtures = new JSONArray();
    for (int i = 0; i < 16; i++)
      fixtures.put(
          RoomApi.object("id", "song-" + i, "title", "合成测试曲 · " + (i + 1), "artist", "测试歌手"));
    songsFixture = fixtures.toString();
    find("歌名点歌").performClick();
    drain();
    layout(960, 540);
    NativeCatalogue catalogue =
        (NativeCatalogue)
            descendants(room).stream().filter(v -> v instanceof NativeCatalogue).findFirst().get();
    assertEquals("Catalogue covers the main video area", 960, catalogue.getRight());
    assertEquals(144, catalogue.getLeft());
    assertFalse(find("隐藏歌词").isShown());
    assertFalse(
        descendants(room).stream().anyMatch(v -> v.getClass().getName().contains("WebView")));
    capture("native-tv-catalogue.png");
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    layout(960, 540);
    capture("native-tv-catalogue-focused.png");
    GridView grid = (GridView) find("歌曲卡片");
    assertTrue(grid.getChildAt(0).isActivated());
    int columns = grid.getNumColumns();
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    layout(960, 540);
    assertEquals("Visible cards do not scroll the grid", 0, grid.getFirstVisiblePosition());
    assertTrue(grid.getChildAt(2).isActivated());
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    layout(960, 540);
    assertTrue(grid.getChildAt(2 + columns - grid.getFirstVisiblePosition()).isActivated());
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    layout(960, 540);
    assertTrue("Remote scroll reveals offscreen cards", grid.getFirstVisiblePosition() > 0);
    press(KeyEvent.KEYCODE_DPAD_UP);
    layout(960, 540);
    assertTrue(grid.getChildAt(2 + columns * 2 - grid.getFirstVisiblePosition()).isActivated());
  }

  @Test
  @Config(qualifiers = "w1396dp-h785dp-land-440dpi")
  public void catalogueKeepsThirdVisibleRowAt440Dpi() throws Exception {
    JSONArray fixtures = new JSONArray();
    for (int i = 0; i < 40; i++)
      fixtures.put(RoomApi.object("id", "song-" + i, "title", "测试曲 " + i, "artist", "测试歌手"));
    songsFixture = fixtures.toString();
    find("歌名点歌").performClick();
    drain();
    layout(3840, 2160);
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    layout(3840, 2160);
    GridView grid = (GridView) find("歌曲卡片");
    int columns = grid.getNumColumns();
    assertTrue("Third row exists", grid.getChildCount() > columns * 2);
    assertTrue("Third row fits inside the actual viewport: bottom="
            + grid.getChildAt(columns * 2).getBottom() + ", height=" + grid.getHeight()
            + ", padding=" + grid.getPaddingBottom() + ", columns=" + columns,
        grid.getChildAt(columns * 2).getBottom() <= grid.getHeight());
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    layout(3840, 2160);
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    layout(3840, 2160);
    assertEquals("Focus on the complete third row does not scroll", 0, grid.getFirstVisiblePosition());
    assertTrue(grid.getChildAt(columns * 2).isActivated());
  }

  @Test
  public void initialKeypadFiltersWithoutOpeningKeyboard() throws Exception {
    find("歌名点歌").performClick();
    drain();
    layout(960, 540);
    find("首字母 Z").requestFocusFromTouch();
    press(KeyEvent.KEYCODE_DPAD_CENTER);
    drain();
    assertTrue(paths.stream().anyMatch(path -> path.contains("initials=Z")));
    assertTrue(find("首字母 Z").hasFocus());
    find("首字母 J").performClick();
    drain();
    assertTrue(paths.stream().anyMatch(path -> path.contains("initials=ZJ")));
    find("退格").performClick();
    drain();
    assertTrue(find("首字母 Z").isShown());
  }

  @Test
  public void fullscreenQueueStaysOutsideFocusNavigation() throws Exception {
    assertTrue(find("手机扫码点歌二维码").isShown());
    find("全屏播放").performClick();
    layout(960, 540);
    assertTrue(find("手机扫码点歌二维码").isShown());
    assertTrue(find("全屏已点歌单").isShown());
    assertFalse(find("手机扫码点歌二维码").isFocusable());
    capture("native-tv-queue-overlay.png");
  }

  @Test
  public void queueConfirmPrioritizesButLongConfirmOnlyOffersDeletion() throws Exception {
    find("已点歌曲").performClick();
    drain();
    JSONObject second =
        RoomApi.object("id", "entry-2", "song_id", "song-2", "title", "下一首", "artist", "测试歌手");
    room.state(
        RoomApi.object(
            "queue",
            new JSONArray().put(song).put(second),
            "playback",
            RoomApi.object("paused", false)));
    layout(960, 540);
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    press(KeyEvent.KEYCODE_DPAD_CENTER);
    drain();
    assertTrue(paths.contains("/api/queue/entry-2/top"));
    long firstCalls = paths.stream().filter(path -> path.endsWith("/top")).count();
    activity.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_CENTER));
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(650));
    activity.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_CENTER));
    drain();
    android.app.AlertDialog dialog =
        org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
    assertNotNull(dialog);
    assertTrue(dialog.isShowing());
    assertEquals(firstCalls, paths.stream().filter(path -> path.endsWith("/top")).count());
    dialog.getListView().performItemClick(dialog.getListView().getChildAt(0), 0, 0);
    drain();
    assertTrue(paths.contains("/api/queue/entry-2"));
  }

  @Test
  public void compactControlsAndPersistentQrFitNormalAndFullScreen() throws Exception {
    View qr = find("手机扫码点歌二维码");
    android.graphics.Rect bounds = new android.graphics.Rect();
    qr.getDrawingRect(bounds);
    room.offsetDescendantRectToMyCoords(qr, bounds);
    assertTrue(bounds.left >= 12 && bounds.right <= 144);
    assertTrue(bounds.top > 280 && bounds.bottom < 440);
    View pause = find("暂停");
    pause.getDrawingRect(bounds);
    room.offsetDescendantRectToMyCoords(pause, bounds);
    assertEquals(480, bounds.centerX(), 2);
    find("歌名点歌").performClick();
    drain();
    layout(960, 540);
    assertTrue(qr.isShown());
    Button letter = (Button) find("首字母 A");
    assertTrue(letter.getTextSize() >= 18);
    assertEquals("", ((Button) find("清空")).getText().toString());
    find("全屏播放").performClick();
    layout(960, 540);
    find("歌词延后 10 秒").getDrawingRect(bounds);
    room.offsetDescendantRectToMyCoords(find("歌词延后 10 秒"), bounds);
    assertTrue(bounds.left > 240);
    find("歌词提前 10 秒").getDrawingRect(bounds);
    room.offsetDescendantRectToMyCoords(find("歌词提前 10 秒"), bounds);
    assertTrue(bounds.right < 720);
    find("退出全屏").performClick();
    layout(960, 540);
    assertTrue(qr.isShown());
    assertFalse(find("全屏已点歌单").isShown());
    capture("native-tv-persistent-qr.png");
  }

  @Test
  public void remoteSortToggleLoadsOnceAndHalfSecondStepsSurviveLargeOffsets() throws Exception {
    find("歌名点歌").performClick();
    drain();
    layout(960, 540);
    assertTrue(paths.stream().anyMatch(path -> path.contains("sort=title")));
    find("精确搜索").requestFocusFromTouch();
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    assertTrue(find("切换歌名排序或随机").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_CENTER);
    drain();
    assertEquals(1, paths.stream().filter(path -> path.contains("sort=random")).count());
    find("全屏播放").performClick();
    room.state(
        RoomApi.object(
            "queue",
            new JSONArray().put(song),
            "playback",
            RoomApi.object("paused", false, "lyricsOffsetMs", 3000000500L)));
    layout(960, 540);
    find("歌词延后 0.5 秒").performClick();
    drain();
    assertEquals(-500, commands.get(commands.size() - 1).optInt("deltaMs"));
    find("歌词提前 0.5 秒").performClick();
    drain();
    assertEquals(500, commands.get(commands.size() - 1).optInt("deltaMs"));
  }

  private void capture(String name) throws Exception {
    java.io.File folder = new java.io.File("build/test-screenshots");
    folder.mkdirs();
    Bitmap image = Bitmap.createBitmap(960, 540, Bitmap.Config.ARGB_8888);
    room.draw(new Canvas(image));
    try (java.io.FileOutputStream out =
        new java.io.FileOutputStream(new java.io.File(folder, name))) {
      image.compress(Bitmap.CompressFormat.PNG, 100, out);
    }
    image.recycle();
  }

  private void drain() throws Exception {
    for (int i = 0; i < 30; i++) {
      Thread.sleep(15);
      Shadows.shadowOf(Looper.getMainLooper()).idle();
    }
  }

  @Test
  public void fullscreenHidesCatalogueAndSidebarAndKeepsSameControls() throws Exception {
    NativeLyricsView lyrics =
        (NativeLyricsView)
            descendants(room).stream().filter(v -> v instanceof NativeLyricsView).findFirst().get();
    assertEquals(View.GONE, lyrics.getVisibility());
    View background = find("演唱画面，确认键全屏");
    assertEquals(144, background.getLeft());
    assertEquals(468, background.getHeight());
    assertEquals(816, background.getWidth());
    View pause = find("暂停");
    find("歌名点歌").performClick();
    drain();
    assertTrue(find("歌名点歌").isShown());
    find("全屏播放").performClick();
    layout(960, 540);
    assertFalse(find("歌名点歌").isShown());
    assertSame(pause, find("暂停"));
    assertEquals(View.VISIBLE, lyrics.getVisibility());
    assertFalse(
        descendants(room).stream().filter(v -> v instanceof GridView).findFirst().get().isShown());
    View stage = find("演唱画面，按下键打开控制，左右键微调歌词");
    assertEquals(0, stage.getLeft());
    assertEquals(960, stage.getWidth());
    assertEquals(540, stage.getHeight());
    find("退出全屏").performClick();
    layout(960, 540);
    assertTrue(find("歌名点歌").isShown());
    assertSame(pause, find("暂停"));
    assertEquals(View.GONE, lyrics.getVisibility());
    assertFalse(
        descendants(room).stream().anyMatch(v -> v.getClass().getName().contains("WebView")));
  }

  @Test
  public void pausedControlsStayHiddenAcrossRepeatedStateUpdates() {
    find("全屏播放").performClick();
    JSONObject pausedState =
        RoomApi.object(
            "queue", new JSONArray().put(song), "playback", RoomApi.object("paused", true));
    room.state(pausedState);
    find("播放").requestFocus();
    room.back();
    assertFalse(find("播放").isShown());
    room.state(pausedState);
    room.state(pausedState);
    assertFalse(find("播放").isShown());
    room.back();
    assertTrue(find("播放").isShown());
  }

  @Test
  public void lyricButtonsHaveReversedDirectionsAndStayConditional() throws Exception {
    find("全屏播放").performClick();
    layout(960, 540);
    assertEquals("0.5\n←", ((Button) find("歌词延后 0.5 秒")).getText().toString());
    assertEquals("3\n→", ((Button) find("歌词提前 3 秒")).getText().toString());
    assertFalse(
        descendants(room).stream()
            .anyMatch(v -> String.valueOf(v.getContentDescription()).contains("0.1 秒")));
    find("歌词延后 0.5 秒").performClick();
    find("歌词提前 3 秒").performClick();
    drain();
    assertEquals(-500, commands.get(0).getInt("deltaMs"));
    assertEquals(3000, commands.get(1).getInt("deltaMs"));
    assertEquals("entry-1", commands.get(1).getString("entryId"));
    find("隐藏歌词").performClick();
    assertFalse(find("歌词延后 0.5 秒").isShown());
    assertFalse(find("重置歌词微调").isShown());
    find("显示歌词").performClick();
    assertTrue(find("歌词延后 0.5 秒").isShown());
    find("重置歌词微调").performClick();
    drain();
    assertTrue(commands.get(2).getBoolean("reset"));
  }

  @Test
  public void iconControlsExplainFocusBrieflyWithoutPermanentLabels() throws Exception {
    for (String name : new String[] {"暂停", "切换原唱伴奏", "切歌", "全屏播放", "隐藏歌词"}) {
      assertEquals("", ((Button) find(name)).getText().toString());
    }
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    assertTrue(find("暂停").hasFocus());
    View hint = find("播放控制提示");
    assertTrue(hint.isShown());
    assertEquals("暂停", ((android.widget.TextView) hint).getText().toString());
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
    assertFalse(hint.isShown());
    assertTrue(find("暂停").hasFocus());
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    assertTrue(hint.isShown());
    assertEquals("切歌", ((android.widget.TextView) hint).getText().toString());
    layout(960, 540);
    capture("native-tv-control-hint.png");
  }

  @Test
  public void pictureArrowsAdjustByHalfASecondAndDoNotStealControlNavigation() throws Exception {
    find("全屏播放").performClick();
    press(KeyEvent.KEYCODE_DPAD_LEFT);
    press(KeyEvent.KEYCODE_DPAD_RIGHT);
    drain();
    assertEquals(-500, commands.get(0).optInt("deltaMs"));
    assertEquals(500, commands.get(1).optInt("deltaMs"));
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    press(KeyEvent.KEYCODE_DPAD_LEFT);
    drain();
    assertTrue(find("切换原唱伴奏").hasFocus());
    assertEquals(2, commands.size());
  }

  @Test
  public void remoteWakeDoesNotPauseAndHiddenControlsCannotReceiveFocus() throws Exception {
    find("全屏播放").performClick();
    press(KeyEvent.KEYCODE_DPAD_DOWN);
    assertTrue(find("暂停").hasFocus());
    Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5));
    assertFalse(find("暂停").isShown());
    room.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_CENTER));
    room.dispatchKeyEvent(
        new KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_CENTER, 2));
    room.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_CENTER));
    drain();
    assertTrue(find("暂停").isShown());
    assertTrue(find("暂停").hasFocus());
    assertEquals(0, commands.size());
    find("暂停").performClick();
    drain();
    assertEquals("pause", commands.get(0).optString("action"));
    assertTrue(room.back());
    assertFalse(find("暂停").isShown());
    assertTrue(room.back());
    assertTrue(find("暂停").isShown());
  }

  @Test
  public void phoneCatalogueKeepsInitialsAndCardsReachable() throws Exception {
    JSONArray songs = new JSONArray();
    for (int i = 0; i < 24; i++) songs.put(RoomApi.object(
        "id", "song-" + i, "title", "歌曲 " + i, "artist", "测试歌手"));
    songsFixture = songs.toString();
    find("歌名点歌").performClick();
    drain();
    for (int[] size : new int[][] {{390, 844}, {844, 390}}) {
      layout(size[0], size[1]);
      View grid = find("歌曲卡片");
      double fraction = (double) grid.getWidth() * grid.getHeight() / (size[0] * size[1]);
      assertTrue("card area " + fraction, fraction > .55);
      assertTrue(find("首字母 A").isShown());
      assertTrue(find("精确搜索").isShown());
      assertFalse(find("搜索歌名或歌手").isShown());

      for (String label : new String[] {"暂停", "切歌", "切换原唱伴奏", "全屏播放"}) {
        View control = find(label);
        int[] xy = new int[2];
        control.getLocationInWindow(xy);
        assertTrue(label, control.isShown() && xy[0] >= 0 && xy[0] + control.getWidth() <= size[0]);
        assertEquals(label + " must stay square", control.getWidth(), control.getHeight());
      }
      java.io.File folder = new java.io.File("build/test-screenshots");
      folder.mkdirs();
      Bitmap image = Bitmap.createBitmap(size[0], size[1], Bitmap.Config.ARGB_8888);
      room.draw(new Canvas(image));
      try (java.io.FileOutputStream out = new java.io.FileOutputStream(
          new java.io.File(folder, "phone-catalogue-" + size[0] + ".png"))) {
        image.compress(Bitmap.CompressFormat.PNG, 100, out);
      }
    }
  }

  @Test
  public void phoneRotatesWithoutReplacingPlayerAndControlsStayReachable() throws Exception {
    java.lang.reflect.Field field = NativeRoom.class.getDeclaredField("player");
    field.setAccessible(true);
    Object player = field.get(room);
    for (int[] size : new int[][] {{390, 844}, {844, 390}, {390, 844}, {960, 540}}) {
      layout(size[0], size[1]);
      find("全屏播放").performClick();
      layout(size[0], size[1]);
      for (String name : new String[] {"暂停", "切歌", "切换原唱伴奏", "歌词提前 0.5 秒", "歌词延后 0.5 秒"}) {
        View button = find(name);
        int[] xy = new int[2];
        button.getLocationInWindow(xy);
        assertTrue(name, button.isShown() && button.getWidth() > 0 && xy[0] >= 0
            && xy[0] + button.getWidth() <= size[0] && xy[1] + button.getHeight() <= size[1]);
      }
      assertSame(player, field.get(room));
      java.io.File folder = new java.io.File("build/test-screenshots");
      folder.mkdirs();
      Bitmap image = Bitmap.createBitmap(size[0], size[1], Bitmap.Config.ARGB_8888);
      room.draw(new Canvas(image));
      try (java.io.FileOutputStream out = new java.io.FileOutputStream(
          new java.io.File(folder, "native-adaptive-" + size[0] + ".png"))) {
        image.compress(Bitmap.CompressFormat.PNG, 100, out);
      }
      find("退出全屏").performClick();
      layout(size[0], size[1]);
    }
  }

  @Test
  public void fullControlsFit720pAndNativeLyricsRender() throws Exception {
    find("全屏播放").performClick();
    layout(960, 540);
    room.lyrics(
        "entry-1",
        new LyricsTimeline("[00:00]今晚的好时光\n[00:10]一起唱喜欢的歌"),
        RoomApi.object("size", 38, "color", "#ffd66e"),
        0);
    for (View view : descendants(room))
      if (view instanceof Button && view.isShown()) {
        int[] xy = new int[2];
        view.getLocationInWindow(xy);
        assertTrue(
            view.getContentDescription() + " outside screen",
            xy[0] >= 0 && xy[0] + view.getWidth() <= 960);
      }
    java.io.File folder = new java.io.File("build/test-screenshots");
    folder.mkdirs();
    Bitmap image = Bitmap.createBitmap(960, 540, Bitmap.Config.ARGB_8888);
    room.draw(new Canvas(image));
    try (java.io.FileOutputStream out =
        new java.io.FileOutputStream(new java.io.File(folder, "native-tv-fullscreen.png"))) {
      image.compress(Bitmap.CompressFormat.PNG, 100, out);
    }
    assertTrue(image.getPixel(20, 500) != 0);
  }
}
