package home.haohaochang.tv;

import android.content.Context;
import android.media.AudioAttributes;
import android.util.Log;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import livekit.org.webrtc.AudioTrack;
import livekit.org.webrtc.DataChannel;
import livekit.org.webrtc.IceCandidate;
import livekit.org.webrtc.MediaConstraints;
import livekit.org.webrtc.MediaStream;
import livekit.org.webrtc.MediaStreamTrack;
import livekit.org.webrtc.PeerConnection;
import livekit.org.webrtc.PeerConnectionFactory;
import livekit.org.webrtc.RtpTransceiver;
import livekit.org.webrtc.SdpObserver;
import livekit.org.webrtc.SessionDescription;
import livekit.org.webrtc.audio.JavaAudioDeviceModule;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;

/** Receives one phone's audio directly on the media route alongside the song player. */
final class NativeMicrophone implements AutoCloseable {
  private static final String TAG = "PhoneMicrophone";
  private static final Pattern MEDIA_LINE = Pattern.compile("(?m)^m=([^ ]+) ");
  private static final Pattern HOST_CANDIDATE = Pattern.compile("\\btyp host\\b");
  private static final OkHttpClient HTTP =
      new OkHttpClient.Builder()
          .followRedirects(false)
          .followSslRedirects(false)
          .pingInterval(15, TimeUnit.SECONDS)
          .build();
  private static boolean initialized;
  private final Context context;
  private final RoomApi api;
  private final String playerId, micKey;
  private Playback playback;

  NativeMicrophone(Context context, RoomApi api, String playerId, String micKey) {
    this.context = context.getApplicationContext();
    this.api = api;
    this.playerId = playerId;
    this.micKey = micKey;
  }

  void active(boolean active) {
    if (!active) close();
    else if (playback == null) {
      playback = new Playback();
      playback.worker.start();
    }
  }

  @Override
  public void close() {
    Playback current = playback;
    playback = null;
    if (current == null) return;
    current.stopped = true;
    current.worker.interrupt();
    WebSocket socket = current.socket;
    if (socket != null) socket.cancel();
  }

  private static synchronized void initialize(Context context) {
    if (initialized) return;
    PeerConnectionFactory.initialize(
        PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions());
    initialized = true;
  }

  private final class Playback implements Runnable {
    final Thread worker = new Thread(this, "phone-microphone");
    volatile boolean stopped;
    volatile WebSocket socket;
    private PeerConnectionFactory factory;

    @Override
    public void run() {
      try {
        while (!stopped) {
          try {
            listen();
          } catch (RoomApi.Failure error) {
            // Older NAS releases do not provide microphone signaling.
            if (error.status == 404) return;
          } catch (InterruptedException error) {
            return;
          } catch (LinkageError error) {
            Log.w(TAG, "WebRTC unavailable on this device", error);
            return;
          } catch (Exception error) {
            Log.d(TAG, "Microphone signaling will retry");
          }
          if (!stopped) Thread.sleep(5000);
        }
      } catch (InterruptedException ignored) {
        // Playback relinquished its room lease or went to the background.
      } finally {
        if (factory != null) factory.dispose();
      }
    }

    private PeerConnectionFactory factory() {
      if (factory != null) return factory;
      initialize(context);
      JavaAudioDeviceModule device =
          JavaAudioDeviceModule.builder(context)
              .setAudioAttributes(
                  new AudioAttributes.Builder()
                      .setUsage(AudioAttributes.USAGE_MEDIA)
                      .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                      .build())
              .setUseLowLatency(true)
              .createAudioDeviceModule();
      try {
        device.setMicrophoneMute(true);
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(device)
            .createPeerConnectionFactory();
        return factory;
      } finally {
        device.release();
      }
    }

    private void listen() throws Exception {
      JSONObject reply =
          (JSONObject) api.json(
              "/api/mic/ticket",
              RoomApi.object("role", "receiver", "playerId", playerId, "micKey", micKey));
      if (stopped) return;
      Request request = new Request.Builder()
          .url(api.absolute("/api/mic/live?ticket=" + RoomApi.encode(reply.getString("ticket"))))
          .build();
      Link link = new Link();
      WebSocket connection = HTTP.newWebSocket(request, link);
      socket = connection;
      try {
        while (!stopped && !link.closed) {
          Runnable event = link.events.poll(1, TimeUnit.SECONDS);
          if (!stopped && !link.closed && event != null) event.run();
        }
      } finally {
        link.finish();
        connection.cancel();
        socket = null;
        link.reset();
      }
    }

    private final class Link extends WebSocketListener {
      final ArrayBlockingQueue<Runnable> events = new ArrayBlockingQueue<>(96);
      volatile boolean closed;
      private Receiver receiver;

      void post(Runnable action) {
        if (!stopped && !closed && !events.offer(action)) finish();
      }

      void finish() {
        closed = true;
        events.clear();
        events.offer(() -> {});
      }

      void reset() {
        Receiver previous = receiver;
        receiver = null;
        if (previous != null && previous.peer != null) previous.peer.dispose();
      }

      void send(JSONObject message) {
        WebSocket connection = socket;
        if (!stopped && !closed && connection != null && !connection.send(message.toString()))
          finish();
      }

      @Override
      public void onMessage(WebSocket socket, String message) {
        post(() -> receive(message));
      }

      @Override
      public void onClosing(WebSocket socket, int code, String reason) {
        finish();
        socket.close(1000, null);
      }

      @Override
      public void onFailure(WebSocket socket, Throwable error, Response response) {
        finish();
      }

      private void receive(String message) {
        if (message.equals("ready")) return;
        if (message.equals("idle")) {
          reset();
          return;
        }
        try {
          JSONObject data = new JSONObject(message);
          if (data.optString("type").equals("offer")) {
            reset();
            String sdp = data.getString("sdp");
            if (!singleAudioOffer(sdp)) return;
            receiver = new Receiver();
            receiver.start(sdp);
          } else if (data.optString("type").equals("candidate") && receiver != null) {
            receiver.add(new IceCandidate(
                data.optString("sdpMid", ""), data.getInt("sdpMLineIndex"),
                data.getString("candidate")));
          }
        } catch (Exception error) {
          reset();
        }
      }

      private final class Receiver implements PeerConnection.Observer {
        private final ArrayList<IceCandidate> remote = new ArrayList<>();
        private final ArrayList<IceCandidate> local = new ArrayList<>();
        private PeerConnection peer;
        private boolean remoteSet, answerSent;

        void start(String offer) {
          PeerConnection.RTCConfiguration config =
              new PeerConnection.RTCConfiguration(Collections.emptyList());
          config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
          config.audioJitterBufferFastAccelerate = true;
          peer = factory().createPeerConnection(config, this);
          if (peer == null) {
            reset();
            return;
          }
          peer.setAudioRecording(false);
          peer.setRemoteDescription(new Description() {
            @Override public void onSetSuccess() {
              current(() -> {
                if (!configureReceiveOnly()) {
                  reset();
                  return;
                }
                remoteSet = true;
                for (IceCandidate candidate : remote) peer.addIceCandidate(candidate);
                remote.clear();
                peer.createAnswer(new Description() {
                  @Override public void onCreateSuccess(SessionDescription value) {
                    current(() -> setLocalAnswer(value));
                  }
                }, new MediaConstraints());
              });
            }
          }, new SessionDescription(SessionDescription.Type.OFFER, offer));
        }

        private boolean configureReceiveOnly() {
          List<RtpTransceiver> tracks = peer.getTransceivers();
          if (tracks.size() != 1) return false;
          RtpTransceiver incoming = tracks.get(0);
          MediaStreamTrack track = incoming.getReceiver().track();
          if (!(track instanceof AudioTrack)
              || !incoming.setDirection(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY))
            return false;
          ((AudioTrack) track).setVolume(0.55);
          return true;
        }

        void add(IceCandidate candidate) {
          if (remoteSet) peer.addIceCandidate(candidate);
          else remote.add(candidate);
        }

        private void setLocalAnswer(SessionDescription answer) {
          peer.setLocalDescription(new Description() {
            @Override public void onSetSuccess() {
              current(() -> {
                send(RoomApi.object("type", "answer", "sdp", answer.description));
                answerSent = true;
                for (IceCandidate candidate : local) sendCandidate(candidate);
                local.clear();
              });
            }
          }, answer);
        }

        private void sendCandidate(IceCandidate candidate) {
          send(RoomApi.object("type", "candidate", "candidate", candidate.sdp,
              "sdpMid", candidate.sdpMid, "sdpMLineIndex", candidate.sdpMLineIndex));
        }

        private void current(Runnable action) {
          post(() -> {
            if (receiver == this) action.run();
          });
        }

        private class Description implements SdpObserver {
          @Override public void onCreateSuccess(SessionDescription value) {}
          @Override public void onSetSuccess() {}
          @Override public void onCreateFailure(String message) { current(Link.this::reset); }
          @Override public void onSetFailure(String message) { current(Link.this::reset); }
        }

        @Override public void onIceCandidate(IceCandidate candidate) {
          if (candidate.sdpMLineIndex != 0 || !HOST_CANDIDATE.matcher(candidate.sdp).find()) return;
          current(() -> {
            if (answerSent) sendCandidate(candidate);
            else local.add(candidate);
          });
        }

        @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
          if (state == PeerConnection.IceConnectionState.FAILED) current(Link.this::reset);
        }

        @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
        @Override public void onIceConnectionReceivingChange(boolean receiving) {}
        @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}
        @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
        @Override public void onAddStream(MediaStream stream) {}
        @Override public void onRemoveStream(MediaStream stream) {}
        @Override public void onDataChannel(DataChannel channel) { channel.close(); }
        @Override public void onRenegotiationNeeded() {}
      }
    }
  }

  private static boolean singleAudioOffer(String sdp) {
    java.util.regex.Matcher media = MEDIA_LINE.matcher(sdp);
    return media.find() && "audio".equals(media.group(1)) && !media.find();
  }
}
