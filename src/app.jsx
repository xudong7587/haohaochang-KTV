import { InitialPicker } from "./initial-picker.jsx";
import { ArtistLibrary } from "./artist-library.jsx";
import { ArtistArtwork } from "./artist-artwork.jsx";
import { SongArtwork } from "./song-artwork.jsx";
import { FeedbackToast } from "./feedback-toast.jsx";
import { version as buildVersion } from "../package.json";
import {
  api,
  roomToken,
  adminToken,
  setAdminToken,
  acceptLogin,
  logout,
  pendingTvPair,
  tvPairFromHash,
} from "./api.js";
import { TvLoginQr, PhonePairing } from "./tv-pairing.jsx";
import { useTvNavigation } from "./playback/tv-navigation.js";
import { modeNames, statusNames } from "./view-constants.js";
import { SearchBox, Empty, Modal } from "./components.jsx";
import { Settings } from "./admin-settings.jsx";
import { Editor } from "./song-editor.jsx";
import { LibraryManager, LyricsSettings } from "./library-manager.jsx";
import { Player } from "./playback/player.jsx";
import { RoomEntry } from "./room-entry.jsx";

import { OnlineSongs } from "./online-songs.jsx";
import { Automation } from "./automation.jsx";
import { tagOptions } from "../shared/tags.js";
import { Organize } from "./organize.jsx";
import { Stage } from "./stage.jsx";
import React, { useEffect, useRef, useState } from "react";

import {
  Mic2,
  Music2,
  Users,
  ListMusic,
  Search,
  Plus,
  Monitor,
  Smartphone,
  Settings2,
  ArrowUp,
  X,
  Play,
  Pause,
  SkipForward,
  Volume2,
  QrCode,
  HardDrive,
  RefreshCw,
  ArrowUpRight,
  Check,
  Globe2,
  Radio,
  ChevronLeft,
  LogOut,
  Download,
  SlidersHorizontal,
  Disc3,
} from "lucide-react";

import { SeparationSettings } from "./separation-settings.jsx";
import { PcDashboard } from "./pc-dashboard.jsx";

const route = ["/", "/admin"].includes(location.pathname)
  ? "admin"
  : ["/mobile", "/control"].includes(location.pathname)
    ? "mobile"
    : "tv";
const SongSelection = route === "tv" ? "button" : React.Fragment;
function InitialResults({ value, onChange, children, tools }) {
  if (route !== "tv") return children;
  return (
    <div className="initial-results-layout">
      <InitialPicker value={value} onChange={onChange}>
        {tools}
      </InitialPicker>
      {children}
    </div>
  );
}
const isWebRoom = location.pathname === "/play";
if (isWebRoom) document.title = "好好唱 · 网页歌房";
const duration = (n) =>
  `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
function IconButton({ icon: Icon, children, ...props }) {
  return (
    <button {...props}>
      <Icon size={19} />
      {children}
    </button>
  );
}

export function App() {
  const [roomSession, setRoomSession] = useState({ id: "legacy" });
  const [choosingRoom, setChoosingRoom] = useState(false);
  const [phonePair, setPhonePair] = useState(
    route === "mobile" ? pendingTvPair : "",
  );
  useEffect(() => {
    if (route !== "mobile") return;
    const scan = () => setPhonePair(tvPairFromHash(location.hash.slice(1)));
    window.addEventListener("hashchange", scan);
    return () => window.removeEventListener("hashchange", scan);
  }, []);
  const [authenticated, setAuthenticated] = useState(
    route === "admin" ? !!adminToken : !!roomToken,
  );
  useEffect(() => {
    if (route !== "admin" || adminToken) return;
    let live = true;
    api("/login", undefined, "GET", true)
      .then((result) => {
        if (!live) return;
        acceptLogin(result.token);
        setAuthenticated(true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const roomReady = authenticated && !choosingRoom;
  const [password, setPassword] = useState(""),
    [loginBusy, setLoginBusy] = useState(false);
  const [state, setState] = useState({
      queue: [],
      playback: { paused: false, vocal: false },
    }),
    [songs, setSongs] = useState([]),
    [artists, setArtists] = useState([]);
  const [tab, setTab] = useState(
      route === "admin" && location.hash === "#online"
        ? "online"
        : route === "tv"
          ? "stage"
          : "songs",
    ),
    [query, setQuery] = useState(""),
    [artist, setArtist] = useState("");
  const [exactSearch, setExactSearch] = useState(false);
  const [tag, setTag] = useState("");
  const [initialQuery, setInitialQuery] = useState("");
  const [songSort, setSongSort] = useState("title");
  useEffect(() => setInitialQuery(""), [tab]);
  const [join, setJoin] = useState(null),
    [showQR, setShowQR] = useState(false),
    [message, setMessage] = useState(""),
    [connected, setConnected] = useState(false);
  const [reactions, setReactions] = useState([]),
    [refresh, setRefresh] = useState(0),
    [taskRefresh, setTaskRefresh] = useState(0),
    [admin, setAdmin] = useState(null),
    [editing, setEditing] = useState(null);
  const [name, setName] = useState(localStorage.getItem("guestName") || "家人");
  const current = state.queue[0] || (route === "tv" ? state.ambient : null);
  const playback = current?.ambient
    ? {
        paused: !!current.paused,
        vocal: true,
        lyricsOffsetMs: state.playback.lyricsOffsetMs,
      }
    : state.playback;
  const notify = (text) => setMessage(text);
  async function attempt(fn, success) {
    try {
      const value = await fn();
      if (success) notify(success);
      return value;
    } catch (e) {
      notify(e.message);
      return null;
    }
  }
  async function login(e) {
    e.preventDefault();
    setLoginBusy(true);
    setAdminToken(password);
    const result = await attempt(() => api("/login", {}, "POST", true));
    if (result) {
      acceptLogin(result.token);
      setAuthenticated(true);
    }
    setLoginBusy(false);
  }
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(""), 4500);
    return () => clearTimeout(t);
  }, [message]);
  useEffect(() => {
    if (!roomReady) return;
    let alive = true;
    const events = new EventSource(
      `/api/events?token=${encodeURIComponent(roomToken)}`,
    );
    events.addEventListener("state", (e) => {
      if (!alive) return;
      setState(JSON.parse(e.data));
      setConnected(true);
    });
    events.addEventListener("library", () => setRefresh((n) => n + 1));
    events.addEventListener("tasks", () => setTaskRefresh((n) => n + 1));
    events.addEventListener("reaction", (e) => {
      const r = JSON.parse(e.data);
      setReactions((v) => [...v.slice(-7), r]);
      setTimeout(
        () => setReactions((v) => v.filter((x) => x.id !== r.id)),
        2400,
      );
    });
    events.onerror = () => setConnected(false);
    api("/join?origin=" + encodeURIComponent(location.origin))
      .then((value) => {
        if (alive) setJoin(value);
      })
      .catch((e) => {
        if (!alive) return;
        if (e.status === 401 && route !== "admin") setAuthenticated(false);
        else notify(e.message);
      });
    return () => {
      alive = false;
      events.close();
    };
  }, [roomReady, roomSession?.id]);
  useEffect(() => {
    if (!roomReady) return;
    let alive = true;
    const timer = setTimeout(
      () =>
        Promise.all([
          api(
            `/songs?q=${encodeURIComponent(query)}&artist=${encodeURIComponent(artist)}&tag=${encodeURIComponent(tag)}&initials=${encodeURIComponent(tab === "songs" ? initialQuery : "")}${isWebRoom ? `&sort=${songSort}` : ""}`,
          ),
          api(
            "/artists?initials=" +
              encodeURIComponent(tab === "artists" ? initialQuery : ""),
          ),
        ])
          .then(([s, a]) => {
            if (alive) {
              setSongs(s);
              setArtists(a);
            }
          })
          .catch((e) => notify(e.message)),
      180,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [
    roomReady,
    roomSession?.id,
    query,
    artist,
    tag,
    refresh,
    initialQuery,
    tab,
    songSort,
  ]);
  useEffect(() => {
    let live = true;
    if (authenticated && route === "admin")
      api("/admin", undefined, "GET", true)
        .then((value) => {
          if (live) setAdmin(value);
        })
        .catch((e) => {
          if (live) notify(e.message);
        });
    return () => {
      live = false;
    };
  }, [authenticated, refresh, taskRefresh]);
  const navigation = useTvNavigation({
    enabled: route === "tv" && !choosingRoom,
    nested: route === "tv" && !isWebRoom,
    tab,
    artist,
    showQR,
    authenticated,
    query,
    tag,
    setTab,
    setArtist,
    setShowQR,
    setQuery,
    setTag,
  });
  const playerActions = useRef(null);
  async function control(action) {
    await attempt(() =>
      api("/control", { action, entryId: current?.id }, "POST"),
    );
  }
  async function add(song) {
    const result = await attempt(() =>
      api("/queue", { songId: song.id, name }, "POST"),
    );
    if (result)
      notify(
        result.preparing
          ? "正在 NAS 预处理，完成后自动加入队列"
          : "已加入点歌队列",
      );
  }
  if (!authenticated && route === "tv")
    return (
      <TvLoginQr onLogin={() => setAuthenticated(true)}>
        <form onSubmit={login}>
          <label>
            管理密码
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button className="primary" disabled={loginBusy}>
            {loginBusy ? "正在连接…" : "进入好好唱"}
            <ArrowUpRight size={18} />
          </button>
        </form>
        {message && (
          <p role="alert" className="error">
            {message}
          </p>
        )}
      </TvLoginQr>
    );
  if (!authenticated)
    return (
      <div className={`login ${route === "tv" ? "tv-login" : ""}`}>
        <div className="login-card">
          <div className="brandmark">
            <Mic2 />
          </div>
          <p className="eyebrow">GOOD TIMES, GREAT SONGS</p>
          <h1>
            好好唱<span>在家，就是主场。</span>
          </h1>
          <p className="muted">
            {phonePair
              ? "登录当前歌房后，确认连接电视。"
              : route === "mobile"
                ? "扫描电视上的二维码，即可加入客厅。也可以输入管理密码连接。"
                : "输入 NAS 管理密码，连接你的家庭歌房。"}
          </p>
          <div className="login-methods">
            {route === "tv" && (
              <TvLoginQr onLogin={() => setAuthenticated(true)} />
            )}
            <details open={route !== "tv"}>
              <summary>使用管理密码登录</summary>
              <form onSubmit={login}>
                <label>
                  管理密码
                  <input
                    autoFocus={route !== "tv"}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="部署时设置的 ADMIN_PASSWORD"
                    required
                  />
                </label>
                <button className="primary" disabled={loginBusy}>
                  {loginBusy ? "正在连接…" : "进入好好唱"}
                  <ArrowUpRight size={18} />
                </button>
              </form>
            </details>
          </div>
          <p className="fine">音乐留在 NAS，快乐留在客厅。</p>
          {message && (
            <p role="alert" className="error">
              {message}
            </p>
          )}
        </div>
      </div>
    );

  if (phonePair)
    return (
      <PhonePairing
        pair={phonePair}
        onAuthRequired={() => setAuthenticated(false)}
        done={() => {
          history.replaceState(null, "", location.pathname);
          setPhonePair("");
        }}
      />
    );
  if (isWebRoom && choosingRoom)
    return (
      <RoomEntry
        onCancel={() => setChoosingRoom(false)}
        onEnter={(room) => {
          setState({ queue: [], playback: { paused: false, vocal: false } });
          setJoin(null);
          setReactions([]);
          setTab("stage");
          setRoomSession(room);
          setChoosingRoom(false);
        }}
      />
    );
  return (
    <div
      className={`app ${route} ${isWebRoom ? "web-room" : ""} ${tab === "stage" ? "stage-home" : ""} ${navigation.entered ? "tv-content-entered" : ""}`}
    >
      <aside className="sidebar">
        <a
          className="brand"
          href={route === "admin" ? "/admin" : isWebRoom ? "/play" : "/tv"}
        >
          <span className="brandmark">
            <Mic2 size={23} />
          </span>
          <span>
            好好唱<small>HOME KARAOKE</small>
          </span>
        </a>
        <div className="room">
          <span className={`dot ${connected ? "" : "offline"}`} />
          <span>
            {state.room?.code ? `歌房 ${state.room.code}` : "我的客厅"}
            <small>{connected ? "已连接 · NAS" : "正在重新连接…"}</small>
          </span>
          <Radio size={17} />
        </div>
        {isWebRoom && (
          <button className="switch-room" onClick={() => setChoosingRoom(true)}>
            独立歌房
          </button>
        )}
        <p className="nav-label">
          {route === "admin" ? "管理工作台" : "发现你的下一首"}
        </p>
        <nav>
          {route === "tv" && (
            <IconButton
              icon={Play}
              className={tab === "stage" ? "selected" : ""}
              onClick={() => setTab("stage")}
            >
              音乐现场
            </IconButton>
          )}
          <IconButton
            icon={Music2}
            className={tab === "songs" ? "selected" : ""}
            onClick={() => {
              setTab("songs");
              setArtist("");
            }}
          >
            {route === "admin" ? "曲库管理" : "歌名点歌"}
          </IconButton>
          <IconButton
            icon={Users}
            className={
              ["artists", "artist-library"].includes(tab) ? "selected" : ""
            }
            onClick={() => {
              setTab("artists");
              setArtist("");
            }}
          >
            {route === "admin" ? "歌星管理" : "歌星点歌"}
          </IconButton>
          <IconButton
            icon={ListMusic}
            className={tab === "queue" ? "selected" : ""}
            onClick={() => setTab("queue")}
          >
            已点歌曲<span className="nav-count">{state.queue.length}</span>
          </IconButton>
          <IconButton
            icon={Globe2}
            className={tab === "online" ? "selected" : ""}
            onClick={() => setTab("online")}
          >
            在线找歌
          </IconButton>
          {route === "admin" && (
            <>
              <IconButton
                icon={Monitor}
                className={tab === "pc" ? "selected" : ""}
                onClick={() => setTab("pc")}
              >
                PC 整理器
              </IconButton>
              <IconButton
                icon={SlidersHorizontal}
                className={tab === "ai" ? "selected" : ""}
                onClick={() => setTab("ai")}
              >
                人声分离
              </IconButton>
              <IconButton
                icon={Settings2}
                className={tab === "settings" ? "selected" : ""}
                onClick={() => setTab("settings")}
              >
                设置与任务
              </IconButton>
            </>
          )}
        </nav>
        <div className="sidebar-bottom">
          {route === "tv" && join && (
            <button className="scan-card" onClick={() => setShowQR(true)}>
              <img src={join.qr} alt="扫码点歌二维码" />
              <strong>让手机成为点歌台</strong>
              <span>扫码连接当前客厅</span>
            </button>
          )}
          <div className="endpoint-links">
            <a href="/play">
              <Monitor size={16} />
              网页歌房
            </a>
            <a href="/admin">
              <Settings2 size={16} />
              管理
            </a>
            <button aria-label="退出" onClick={logout}>
              <LogOut size={16} />
            </button>
          </div>
          <span className="fine">好好唱 · 把日子唱成歌</span>
          {route === "admin" && (
            <div className="app-version">
              <span>v{admin?.version || buildVersion}</span>
              <a
                href="https://github.com/xudong7587/haohaochang-KTV"
                target="_blank"
                rel="noreferrer"
              >
                GitHub ↗
              </a>
            </div>
          )}
        </div>
      </aside>
      <main tabIndex={-1} onFocusCapture={navigation.onContentFocus}>
        <header>
          <div className="breadcrumb">
            {state.room?.code ? `歌房 ${state.room.code}` : "我的客厅"}{" "}
            <span>/</span>{" "}
            {route === "admin"
              ? "曲库管理"
              : route === "mobile"
                ? "随身点歌台"
                : isWebRoom
                  ? "网页歌房"
                  : "家庭 KTV"}
          </div>
          <div className="header-right">
            {isWebRoom && (
              <button
                className="mobile-room-switch"
                onClick={() => setChoosingRoom(true)}
              >
                独立歌房
              </button>
            )}
            {route === "admin" && (
              <a
                className="web-room-link"
                href="/play"
                target="_blank"
                rel="noopener"
              >
                <Monitor size={18} />
                打开网页歌房
              </a>
            )}
            <span className="connection">
              <span className={`dot ${connected ? "" : "offline"}`} />
              {connected ? "NAS 在线" : "连接中"}
            </span>
            <button
              className="icon-only"
              aria-label="扫码点歌"
              onClick={() => setShowQR(true)}
            >
              <QrCode size={20} />
            </button>
          </div>
        </header>
        <div className="content">
          {route === "admin" && admin?.readOnlyMedia && (
            <p className="preview-mode-banner">
              本地预览 · NAS 媒体只读，任务仅展示快照
            </p>
          )}
          {tab === "artist-library" && artist && (
            <ArtistLibrary
              key={artist}
              artist={artist}
              manage={route === "admin"}
              add={add}
              request={(url, body, method) =>
                api(url, body, method, route === "admin")
              }
              token={roomToken}
              notify={notify}
              refreshProfile={() => setRefresh((n) => n + 1)}
              back={() => {
                setArtist("");
                setTab("artists");
              }}
            />
          )}
          {route === "tv" && tab === "stage" && (
            <Stage
              current={current}
              songs={songs}
              add={add}
              choose={() => setTab("songs")}
              qr={() => setShowQR(true)}
              token={roomToken}
            />
          )}
          {tab === "songs" && route !== "admin" && !artist && (
            <section className="hero">
              <div>
                <p className="eyebrow">YOUR LIVING ROOM. YOUR STAGE.</p>
                <h1>
                  {route === "admin"
                    ? "好歌，随时就绪。"
                    : "今晚，唱点开心的。"}
                </h1>
                <p>
                  {route === "admin"
                    ? "把收藏整理好，下次相聚只管开唱。"
                    : "一首熟悉的旋律，一屋子喜欢的人。"}
                </p>
                <div className="hero-tags">
                  <span>
                    <HardDrive size={14} />
                    本地优先
                  </span>
                  <span>
                    <Smartphone size={14} />
                    扫码点歌
                  </span>
                  <span>
                    <Volume2 size={14} />
                    原唱 / 伴奏
                  </span>
                </div>
              </div>
              <div className="record-art" aria-hidden="true">
                <div className="record">
                  <div className="record-label">
                    <Music2 size={32} />
                    <small>
                      GOOD
                      <br />
                      TIMES
                    </small>
                  </div>
                </div>
                <div className="record-note">
                  SIDE A<br />
                  <strong>一起唱吧</strong>
                  <span>33⅓ RPM · HOME SESSION</span>
                </div>
              </div>
            </section>
          )}
          {tab === "songs" && route === "admin" && (
            <LibraryManager
              request={(url, body, method) => api(url, body, method, true)}
              notify={notify}
              onEdit={setEditing}
            />
          )}
          {tab === "songs" && route !== "admin" && (
            <>
              <div className="section-heading">
                <div>
                  <h2>
                    {artist ||
                      (route === "admin" ? "我的曲库" : "从喜欢的歌开始")}
                    <span className="count">{songs.length}</span>
                  </h2>
                  <p>
                    {artist
                      ? "这位歌手的本地歌曲"
                      : "歌名、歌手、拼音首字母，都能找到。"}
                  </p>
                </div>
                {route === "admin" ? (
                  <>
                    <button onClick={() => setTab("settings")}>整理曲库</button>
                    <IconButton
                      icon={RefreshCw}
                      onClick={() =>
                        attempt(
                          () => api("/admin/scan", {}, "POST", true),
                          "已开始扫描媒体目录",
                        )
                      }
                    >
                      扫描曲库
                    </IconButton>
                  </>
                ) : (
                  <span className="pill">本地曲库</span>
                )}
              </div>
              {!isWebRoom && (
                <div className="library-search">
                  <SearchBox query={query} setQuery={setQuery} />
                  <select
                    aria-label="按标签筛选"
                    value={tag}
                    onChange={(e) => setTag(e.target.value)}
                  >
                    <option value="">全部标签</option>
                    {tagOptions.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </div>
              )}
              {artist && (
                <button
                  className="back"
                  onClick={() => {
                    setArtist("");
                    setTab("artists");
                  }}
                >
                  <ChevronLeft size={16} />
                  返回歌手
                </button>
              )}
              <InitialResults
                tools={
                  isWebRoom && (
                    <div className="catalogue-tools">
                      <div className="catalogue-tool-buttons">
                        <button
                          aria-label="精确搜索"
                          aria-expanded={exactSearch}
                          onClick={() => setExactSearch(!exactSearch)}
                        >
                          <Search size={19} />
                        </button>
                        {tab === "songs" && (
                          <button
                            aria-label="切换歌曲排序"
                            title={
                              songSort === "title" ? "歌名排序" : "随机排序"
                            }
                            onClick={() =>
                              setSongSort((value) =>
                                value === "title" ? "random" : "title",
                              )
                            }
                          >
                            <SlidersHorizontal size={19} />
                          </button>
                        )}
                      </div>
                      {exactSearch && (
                        <SearchBox query={query} setQuery={setQuery} />
                      )}
                    </div>
                  )
                }
                value={initialQuery}
                onChange={(value) => {
                  setInitialQuery(value);
                  setQuery("");
                }}
              >
                <div className="song-poster-grid song-search-grid">
                  {songs.map((song) => {
                    const added = state.queue.some(
                      (q) => q.song_id === song.id,
                    );
                    return (
                      <article className="song-poster-card" key={song.id}>
                        <SongSelection
                          {...(route === "tv"
                            ? {
                                className: "song-poster-select",
                                disabled: song.status === "preparing" || added,
                                onClick: () => add(song),
                                "aria-label": `选择歌曲 ${song.title}`,
                              }
                            : {})}
                        >
                          <div className="song-poster-image">
                            <SongArtwork
                              song={song}
                              token={roomToken}
                              size={52}
                            />
                            <span className="poster-duration">
                              {duration(song.duration)}
                            </span>
                          </div>
                          <div className="poster-song-info">
                            <strong>{song.title}</strong>
                            <small>{song.artist}</small>
                          </div>
                        </SongSelection>
                        <div className="poster-song-actions">
                          <small>
                            {song.status !== "ready"
                              ? statusNames[song.status]
                              : modeNames[song.mode]}
                          </small>
                          <button
                            className={added ? "added" : "add-song"}
                            disabled={song.status === "preparing" || added}
                            onClick={() => add(song)}
                            aria-label={`点歌 ${song.title}`}
                          >
                            {added ? <Check size={18} /> : <Plus size={18} />}
                            <span>{added ? "已点" : "点歌"}</span>
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </InitialResults>
              {!songs.length && (
                <Empty
                  icon={Disc3}
                  title={query ? "还没找到这首歌" : "把第一首好歌带回家"}
                  text={
                    query
                      ? "试试拼音首字母，或去在线找歌。"
                      : route === "admin"
                        ? "映射 NAS 歌曲目录后，点击「扫描曲库」。"
                        : "曲库还没有歌曲，请在 NAS 管理后台扫描并准备歌曲。"
                  }
                  action={
                    <button
                      onClick={() =>
                        route === "admin"
                          ? setTab("settings")
                          : setTab("online")
                      }
                    >
                      {route === "admin" ? "查看媒体目录" : "去在线找歌"}
                      <ArrowUpRight size={16} />
                    </button>
                  }
                />
              )}
            </>
          )}
          {tab === "artists" && (
            <>
              <div className="section-heading">
                <div>
                  <h1>
                    {route === "admin" ? "歌星管理" : "总有一位，唱进心里。"}
                  </h1>
                  <p>
                    {route === "admin"
                      ? "收藏喜欢的歌星，编辑照片、介绍与歌曲。"
                      : "按歌手找到你熟悉的旋律。"}
                  </p>
                </div>
                <Users size={30} />
              </div>
              <InitialResults
                tools={
                  isWebRoom && (
                    <div className="catalogue-tools">
                      <div className="catalogue-tool-buttons">
                        <button
                          aria-label="精确搜索"
                          aria-expanded={exactSearch}
                          onClick={() => setExactSearch(!exactSearch)}
                        >
                          <Search size={19} />
                        </button>
                        {tab === "songs" && (
                          <button
                            aria-label="切换歌曲排序"
                            title={
                              songSort === "title" ? "歌名排序" : "随机排序"
                            }
                            onClick={() =>
                              setSongSort((value) =>
                                value === "title" ? "random" : "title",
                              )
                            }
                          >
                            <SlidersHorizontal size={19} />
                          </button>
                        )}
                      </div>
                      {exactSearch && (
                        <SearchBox query={query} setQuery={setQuery} />
                      )}
                    </div>
                  )
                }
                value={initialQuery}
                onChange={(value) => {
                  setInitialQuery(value);
                  setQuery("");
                }}
              >
                <div className="artist-grid">
                  {artists.map((a) => (
                    <button
                      className="artist-card artist-photo-card"
                      data-artist={a.artist}
                      key={a.artist}
                      onClick={() => {
                        setArtist(a.artist);
                        setQuery("");
                        setTab("artist-library");
                      }}
                    >
                      <span className="artist-card-photo">
                        <ArtistArtwork profile={a} token={roomToken} />
                      </span>
                      <span className="artist-card-caption">
                        <strong>{a.artist}</strong>
                        <small>{a.count} 首歌曲</small>
                      </span>
                    </button>
                  ))}
                </div>
              </InitialResults>
              {!artists.length && (
                <Empty
                  icon={Users}
                  title="歌手们还在路上"
                  text="扫描曲库后，歌手会自动出现在这里。"
                />
              )}
            </>
          )}
          {tab === "queue" && (
            <>
              <div className="section-heading">
                <div>
                  <h1>好歌，一首接一首。</h1>
                  <p>正在播放的歌曲保持在最前，接下来由你安排。</p>
                </div>
                <span className="pill">{state.queue.length} 首已点</span>
              </div>
              {state.pending?.length > 0 && (
                <div className="settings-card">
                  <h3>NAS 正在为你准备</h3>
                  {state.pending.map((j) => (
                    <p key={j.id}>
                      {j.title} · {statusNames[j.status]}
                    </p>
                  ))}
                  <p>准备完成后自动排入队列，当前播放不受影响。</p>
                </div>
              )}
              <div className="queue-list">
                {state.queue.map((q, i) => (
                  <div className="queue-row" key={q.id}>
                    {isWebRoom && (
                      <span className="queue-artwork">
                        <SongArtwork
                          song={{ ...q, id: q.song_id }}
                          token={roomToken}
                          size={36}
                        />
                      </span>
                    )}
                    <span className="queue-number">
                      {i === 0 ? (
                        <Volume2 size={21} />
                      ) : (
                        String(i + 1).padStart(2, "0")
                      )}
                    </span>
                    <div>
                      <strong>{q.title}</strong>
                      <small>
                        {q.artist} · {q.name} 点的
                      </small>
                    </div>
                    {i === 0 ? (
                      <span className="pill">
                        {state.playback.paused ? "已暂停" : "当前歌曲"}
                      </span>
                    ) : (
                      <>
                        <button
                          aria-label={`置顶 ${q.title}`}
                          onClick={() =>
                            attempt(() => api(`/queue/${q.id}/top`, {}, "POST"))
                          }
                        >
                          <ArrowUp size={18} />
                        </button>
                        <button
                          aria-label={`移除 ${q.title}`}
                          onClick={() =>
                            attempt(() =>
                              api(`/queue/${q.id}`, undefined, "DELETE"),
                            )
                          }
                        >
                          <X size={18} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              {!state.queue.length && (
                <Empty
                  icon={ListMusic}
                  title="舞台已经准备好了"
                  text="点上第一首歌，今晚从你开始。"
                  action={
                    <button className="primary" onClick={() => setTab("songs")}>
                      去点歌
                      <Plus size={18} />
                    </button>
                  }
                />
              )}
            </>
          )}
          {tab === "online" && (
            <OnlineSongs
              initialTitle={query}
              notify={notify}
              canLogin={route === "admin"}
              mobile={route !== "admin"}
              name={name}
            />
          )}
          {tab === "settings" && admin && (
            <>
              <Settings
                admin={admin}
                attempt={attempt}
                refresh={() => setTaskRefresh((n) => n + 1)}
              />
            </>
          )}
          {route === "admin" && tab === "pc" && <PcDashboard embedded />}
          {route === "admin" && tab === "ai" && (
            <>
              <div className="section-heading">
                <div>
                  <h1>人声分离</h1>
                  <p>管理电脑与 NAS 的分离服务，自动选择可用设备。</p>
                </div>
              </div>
              <SeparationSettings />
            </>
          )}
          {route === "mobile" && (
            <section className="reactions-panel">
              <h3>给台上的人一点掌声</h3>
              <div>
                {["👏", "🎉", "❤️", "🌟"].map((emoji) => (
                  <button
                    aria-label={`发送 ${emoji}`}
                    key={emoji}
                    onClick={() =>
                      attempt(
                        () => api("/reactions", { emoji }, "POST"),
                        "已送到电视大屏",
                      )
                    }
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <label>
                怎么称呼你
                <input
                  value={name}
                  maxLength={24}
                  onChange={(e) => {
                    setName(e.target.value);
                    localStorage.setItem("guestName", e.target.value);
                  }}
                />
              </label>
            </section>
          )}
        </div>
      </main>
      {route === "tv" && (
        <Player
          actionsRef={playerActions}
          playerType={isWebRoom ? "web" : "tv"}
          activePlayer={state.player}
          keyboardLyrics={tab === "stage"}
          current={current}
          playback={playback}
          notify={notify}
          reactions={reactions}
          join={join}
          queue={state.queue}
          request={api}
          token={roomToken}
        />
      )}
      <footer className="player-bar">
        <div
          className="now-playing"
          role={route === "tv" ? "button" : undefined}
          tabIndex={route === "tv" ? 0 : undefined}
          aria-label={route === "tv" ? "返回播放画面" : undefined}
          onClick={() => {
            if (route === "tv") setTab("stage");
          }}
          onKeyDown={(event) => {
            if (route === "tv" && ["Enter", " "].includes(event.key)) {
              event.preventDefault();
              setTab("stage");
            }
          }}
        >
          <div className="mini-record">
            <Music2 size={18} />
          </div>
          <div>
            <strong>{current?.title || "下一首，就唱你喜欢的"}</strong>
            <small>
              {current
                ? `${current.artist} · ${current.ambient ? "随机播放 · 原唱" : current.mode === "original" ? "原唱" : playback.vocal ? "原唱" : "伴奏"}`
                : "点一首歌，开启今晚的好时光"}
            </small>
          </div>
        </div>
        <div className="play-controls">
          <button
            disabled={!current || current.ambient}
            onClick={() => control("vocal")}
            aria-label="切换原唱伴奏"
            className={playback.vocal ? "active-control" : ""}
          >
            <Mic2 size={19} />
            <span>
              {current?.mode === "original"
                ? "原始音频"
                : playback.vocal
                  ? "原唱"
                  : "伴奏"}
            </span>
          </button>
          <button
            className="play-toggle"
            disabled={!current}
            onClick={() => control("pause")}
            aria-label={playback.paused ? "播放" : "暂停"}
          >
            {playback.paused || !current ? (
              <Play size={21} />
            ) : (
              <Pause size={21} />
            )}
          </button>
          <button
            disabled={!current}
            aria-label="切歌"
            onClick={() => control("next")}
          >
            <SkipForward size={21} />
            <span>切歌</span>
          </button>
          {route === "tv" && (
            <button
              data-open-fullscreen
              aria-label="全屏播放"
              onClick={() => playerActions.current?.fullscreen()}
            >
              <Monitor size={21} />
              <span>全屏</span>
            </button>
          )}
        </div>
        <button className="queue-link" onClick={() => setTab("queue")}>
          <ListMusic size={20} />
          <span>已点 {state.queue.length}</span>
        </button>
      </footer>
      {showQR && (
        <Modal title="手机扫码，一起点歌" close={() => setShowQR(false)}>
          {join ? (
            <div className="join-modal">
              <img src={join.qr} alt="手机扫码点歌" />
              <p>扫码即加入当前歌房，无需输入网址和密码。</p>
              <p className="fine">
                点歌、切歌、送掌声，都在手机上完成。
                <br />
                二维码连接 NAS 后端，请只分享给一起唱歌的人。
              </p>
            </div>
          ) : (
            <p>二维码暂时不可用，请检查 NAS 连接。</p>
          )}
        </Modal>
      )}
      {editing && (
        <Editor
          song={editing}
          close={() => setEditing(null)}
          attempt={attempt}
          refresh={() => setRefresh((n) => n + 1)}
        />
      )}
      <FeedbackToast message={message} />
    </div>
  );
}
