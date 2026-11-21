// Read-only chat activity for highlight detection. Only Twitch is supported: its chat allows anonymous
// read-only connections. Kick, YouTube and TikTok need registered API apps, so they fall back to audio alone.
const KEEP_MS = 10 * 60_000;

export function twitchLogin(url) {
  const u = new URL(url);
  return u.hostname.replace(/^www\./, "") === "twitch.tv" ? u.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? null : null;
}

// A "!clip" chat command: who typed it (a login) and whether they're the streamer, a moderator or a VIP.
// `line` is one IRC line with Twitch tags (@badges=...;mod=1;... :nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :!clip).
export function clipCommand(line) {
  const at = line.indexOf(" PRIVMSG #");
  if (at < 0) return null;
  const text = line.slice(line.indexOf(" :", at) + 2).trim();
  if (!/^!clip(?:\s|$)/i.test(text)) return null;
  const tags = line.startsWith("@") ? Object.fromEntries(line.slice(1, line.indexOf(" ")).split(";").map(kv => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; })) : {};
  const badges = (tags.badges ?? "").split(",").map(b => b.split("/")[0]);
  const rest = line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line;
  const by = rest.startsWith(":") ? rest.slice(1).split("!")[0].toLowerCase() : "";
  return { by, mod: tags.mod === "1" || badges.some(b => b === "broadcaster" || b === "moderator" || b === "vip") };
}

export function openChat(url) {
  const login = twitchLogin(url);
  return login ? new TwitchChat(login) : null;
}

export class TwitchChat {
  constructor(login) {
    this.login = login;
    this.times = [];        // epoch ms of each chat message
    this.lines = [];        // { t, text } of recent messages, for the AI writer (what chat said about a moment)
    this.commands = [];     // { t, by, mod } of recent "!clip" commands
    this.since = Date.now(); // start of continuous observation, reset after a reconnect gap
    this.closed = false;
    this.attempt = 0;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    const ws = this.ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    ws.addEventListener("open", () => {
      // justinfanNNNN is Twitch's anonymous, read-only login.
      ws.send("CAP REQ :twitch.tv/tags"); ws.send("PASS SCHMOOPIIE"); ws.send("NICK justinfan" + Math.floor(10_000 + Math.random() * 80_000)); ws.send("JOIN #" + this.login);
      this.attempt = 0;
    });
    ws.addEventListener("message", event => {
      const now = Date.now();
      for (const line of String(event.data).split("\r\n")) {
        if (line.startsWith("PING")) ws.send("PONG" + line.slice(4));
        else if (line.includes(" PRIVMSG #")) {
          this.times.push(now);
          const text = line.slice(line.indexOf(" :", line.indexOf(" PRIVMSG #")) + 2).trim().slice(0, 200);
          if (text) this.lines.push({ t: now, text });
          const command = clipCommand(line);
          if (command) this.commands.push({ t: now, ...command });
        }
      }
      if (this.times.length && this.times[0] < now - KEEP_MS) this.times = this.times.filter(t => t >= now - KEEP_MS);
      if (this.commands.length > 200) this.commands = this.commands.slice(-200);
      if (this.lines.length > 3000 || (this.lines.length && this.lines[0].t < now - KEEP_MS)) this.lines = this.lines.filter(l => l.t >= now - KEEP_MS).slice(-3000);
    });
    ws.addEventListener("close", () => {
      if (this.closed) return;
      // Messages were missed while disconnected, so the baseline restarts after reconnecting.
      this.since = Date.now();
      setTimeout(() => this.connect(), Math.min(60_000, 2_000 * 2 ** this.attempt++));
    });
    ws.addEventListener("error", () => {});
  }

  close() { this.closed = true; try { this.ws?.close(); } catch { /* already closed */ } }
}
