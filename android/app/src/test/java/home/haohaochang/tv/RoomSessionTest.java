package home.haohaochang.tv;

import static org.junit.Assert.*;

import android.os.Looper;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class RoomSessionTest {
  static class Events implements RoomSession.Listener {
    final List<JSONObject> states = new CopyOnWriteArrayList<>(),
        media = new CopyOnWriteArrayList<>();
    final List<String> errors = new CopyOnWriteArrayList<>(),
        lyricEntries = new CopyOnWriteArrayList<>();
    boolean allowed;

    public void state(JSONObject state) {
      states.add(state);
    }

    public void permission(boolean value) {
      allowed = value;
    }

    public void error(String message, boolean auth) {
      errors.add(message);
    }

    public void media(String entry, JSONObject resources, boolean legacy) {
      media.add(RoomApi.object("entry", entry, "resources", resources));
    }

    public void lyrics(String entry, LyricsTimeline lyrics, JSONObject style, double offset) {
      lyricEntries.add(entry);
    }
  }

  private static void drain() throws Exception {
    for (int i = 0; i < 30; i++) {
      Thread.sleep(15);
      Shadows.shadowOf(Looper.getMainLooper()).idle();
    }
  }

  private static JSONObject state(String entry) {
    return RoomApi.object(
        "queue",
        entry.isEmpty()
            ? new JSONArray()
            : new JSONArray()
                .put(
                    RoomApi.object(
                        "id", entry, "song_id", entry, "duration", 20, "lyrics", "[00:00]歌词")),
        "playback",
        RoomApi.object("paused", false));
  }

  @Test
  public void microphoneTicketUsesThePrivateHeartbeatKey() throws Exception {
    Events events = new Events();
    AtomicReference<String> heartbeatKey = new AtomicReference<>();
    AtomicReference<String> receiverKey = new AtomicReference<>();
    CountDownLatch ticketRequested = new CountDownLatch(1);
    try (LocalNas nas = new LocalNas((path, headers, body) -> {
          if (path.equals("/api/player/heartbeat")) {
            JSONObject heartbeat = new JSONObject(body);
            heartbeatKey.set(heartbeat.getString("micKey"));
            return new LocalNas.Reply(200, RoomApi.object(
                "owner", RoomApi.object("id", heartbeat.getString("id"), "revision", 1)).toString());
          }
          if (path.equals("/api/mic/ticket")) {
            JSONObject ticket = new JSONObject(body);
            if (ticket.optString("role").equals("receiver")) receiverKey.set(ticket.optString("micKey"));
            ticketRequested.countDown();
            return new LocalNas.Reply(404, "{}");
          }
          return new LocalNas.Reply(200, state("").toString());
        });
        RoomSession session = new RoomSession(new RoomApi(nas.origin(), "token"), events);
        NativeMicrophone microphone = new NativeMicrophone(
            RuntimeEnvironment.getApplication(), session.api, session.playerId, session.micKey)) {
      session.start();
      drain();
      assertTrue(events.allowed);
      microphone.active(true);
      assertTrue(ticketRequested.await(2, TimeUnit.SECONDS));
      String key = heartbeatKey.get();
      assertTrue(key != null && key.matches("[a-f0-9]{32}"));
      assertTrue("receiver must use the same private key sent with its lease", key.equals(receiverKey.get()));
    }
  }

  @Test
  public void supersededMediaResponseCannotLoadOldSong() throws Exception {
    CountDownLatch oldStarted = new CountDownLatch(1), releaseOld = new CountDownLatch(1);
    Events events = new Events();
    try (LocalNas nas =
            new LocalNas(
                (path, headers, body) -> {
                  if (path.equals("/old")) return new LocalNas.Reply(200, state("old").toString());
                  if (path.equals("/new")) return new LocalNas.Reply(200, state("new").toString());
                  if (path.startsWith("/api/playback-assets/")) {
                    if (path.endsWith("old")) {
                      oldStarted.countDown();
                      releaseOld.await(4, TimeUnit.SECONDS);
                    }
                    return new LocalNas.Reply(
                        200,
                        RoomApi.object(
                                "version",
                                2,
                                "resources",
                                RoomApi.object(
                                    "vocal",
                                    RoomApi.object(
                                        "available",
                                        true,
                                        "url",
                                        "/api/assets/"
                                            + (path.endsWith("old") ? "old" : "new")
                                            + "/vocal")))
                            .toString());
                  }
                  return new LocalNas.Reply(200, "{}");
                });
        RoomSession session =
            new RoomSession(new RoomApi(nas.origin(), "private-room-token"), events)) {
      session.command("/old", "POST", new JSONObject(), null);
      drain();
      assertTrue(oldStarted.await(1, TimeUnit.SECONDS));
      session.command("/new", "POST", new JSONObject(), null);
      drain();
      releaseOld.countDown();
      drain();
      assertEquals(1, events.media.size());
      assertEquals("new", events.media.get(0).optString("entry"));
      assertEquals("new", events.lyricEntries.get(0));
      assertTrue(
          events
              .media
              .get(0)
              .getJSONObject("resources")
              .getJSONObject("vocal")
              .getString("url")
              .contains("token=private-room-token"));
    } finally {
      releaseOld.countDown();
    }
  }

  @Test
  public void delayedSuccessfulHeartbeatCannotUndoRevocation() throws Exception {
    Events events = new Events();
    AtomicInteger beats = new AtomicInteger();
    CountDownLatch secondStarted = new CountDownLatch(1), releaseSecond = new CountDownLatch(1);
    try (LocalNas nas =
            new LocalNas(
                (path, headers, body) -> {
                  if (path.equals("/api/player/heartbeat")) {
                    JSONObject request = new JSONObject(body);
                    if (beats.incrementAndGet() == 2) {
                      secondStarted.countDown();
                      releaseSecond.await(4, TimeUnit.SECONDS);
                    }
                    return new LocalNas.Reply(
                        200,
                        RoomApi.object(
                                "owner",
                                RoomApi.object("id", request.optString("id"), "revision", 1))
                            .toString());
                  }
                  if (path.equals("/revoke"))
                    return new LocalNas.Reply(
                        200,
                        RoomApi.object(
                                "queue",
                                new JSONArray(),
                                "player",
                                RoomApi.object("id", "other-tv", "revision", 2))
                            .toString());
                  return new LocalNas.Reply(200, state("").toString());
                });
        RoomSession session = new RoomSession(new RoomApi(nas.origin(), "token"), events)) {
      session.start();
      drain();
      assertTrue(events.allowed);
      Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(6));
      assertTrue(secondStarted.await(2, TimeUnit.SECONDS));
      session.command("/revoke", "POST", new JSONObject(), null);
      drain();
      assertFalse(events.allowed);
      releaseSecond.countDown();
      drain();
      assertFalse(events.allowed);
      assertFalse(events.errors.isEmpty());
      int before = beats.get();
      Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(6));
      drain();
      assertEquals(before, beats.get());
    } finally {
      releaseSecond.countDown();
    }
  }

  @Test
  public void transientPollFailureKeepsLeaseButExpiredHeartbeatStopsPlayback() throws Exception {
    Events events = new Events();
    java.util.concurrent.atomic.AtomicBoolean failing = new java.util.concurrent.atomic.AtomicBoolean();
    try (LocalNas nas = new LocalNas((path, headers, body) -> {
      if (failing.get()) return new LocalNas.Reply(503, "{}");
      return new LocalNas.Reply(200, "{}");
    }); RoomSession session = new RoomSession(new RoomApi(nas.origin(), "test-token"), events)) {
      session.start();
      drain();
      assertTrue(events.allowed);
      failing.set(true);
      Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));
      drain();
      assertTrue(events.allowed);
      assertTrue(events.errors.isEmpty());
      Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(10));
      drain();
      assertFalse(events.allowed);
    }
  }

  @Test
  public void transportDoesNotForwardCredentialsAcrossRedirectsAndBoundsResponses()
      throws Exception {
    AtomicInteger calls = new AtomicInteger();
    try (LocalNas nas =
            new LocalNas(
                (path, headers, body) -> {
                  calls.incrementAndGet();
                  assertTrue(headers.contains("Bearer secret"));
                  if (path.equals("/redirect"))
                    return new LocalNas.Reply(302, "{}", "Location: https://example.com/steal\r\n");
                  return new LocalNas.Reply(200, "0123456789");
                });
        RoomApi api = new RoomApi(nas.origin(), "secret")) {
      try {
        api.json("/redirect", null);
        fail("redirect accepted");
      } catch (RoomApi.Failure expected) {
        assertEquals(302, expected.status);
      }
      assertEquals(1, calls.get());
      try {
        api.bytes("/large", "GET", null, 4);
        fail("oversized accepted");
      } catch (RoomApi.Failure expected) {
        assertEquals(413, expected.status);
      }
      try {
        api.json("https://example.com/private", null);
        fail("foreign origin accepted");
      } catch (RoomApi.Failure expected) {
        assertEquals(400, expected.status);
      }
      assertEquals(2, calls.get());
    }
  }
}
