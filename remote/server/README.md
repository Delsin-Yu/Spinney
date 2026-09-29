# spinney-relay

A self-hosted rendezvous/relay for the remote-control feature. Harness clients (a VS Code
extension over `fetch`/SSE) and the Android app both dial OUT to it; the relay pairs the peers
that share a room id and forwards opaque frames between them.

C# on .NET 10, ASP.NET Core Minimal API, Native AOT, published `linux-x64` from a Windows host.

---

## What it is

- A rendezvous point: both sides make outbound connections, so neither needs a listening port or
  a public address of its own.
- A dumb byte pipe: `POST .../up` hands the relay a body, and the relay hands that body to the
  other peers of the room inside one SSE `data:` line. The bytes are forwarded verbatim.
- Ephemeral where it routes: a live room exists only while peers are in it. It does remember
  **which room ids exist** - an id and its last use in a small ledger file, no token, no content,
  no peer, no room name - so that a client which asks to *enter* a room nobody ever created is
  told so instead of being handed a silent, empty one (`POST /v2/room/{roomId}/join`).

## What it is not

- **It never looks inside a frame.** No parse, no decrypt, no validate-JSON, no transform. The
  only byte-level inspection is a scan for CR/LF (SSE injection) and a length check.
- **It never logs or stores a body.** No frame body reaches the log, the disk, or a metric. No
  history, no replay, no store-and-forward, no ack: a frame is delivered to the queues that exist
  at that instant and is then forgotten.
- **It has no accounts, no identity and no authorization.** A room id is a bearer credential:
  anyone who knows it can join the room and read every frame.
- **It does not compress, batch, order across peers, or guarantee delivery.** A peer that cannot
  keep up is dropped (see below), never blocked.
- **It is not the loopback control plane.** `docs/agents/control-plane.md` describes a
  localhost-only control surface of the extension; this folder is a public-facing network relay
  and shares no code with it.

## Routes

| Route | Success | Body |
| --- | --- | --- |
| `GET /healthz` | 200 | `{"ok":true,"rooms":<int>,"peers":<int>,"uptimeMs":<int>}` |
| `POST /v2/room/{roomId}/join` | 200 | `{"peer":"<8 lowercase hex chars>","created":<bool>}` - body `{"mode":"create"\|"join"}` |
| `POST /v1/room/{roomId}/join` | 200 | `{"peer":"<8 lowercase hex chars>"}` (4 random bytes) |
| `GET /v1/room/{roomId}/down?peer=<id>` | 200 | `text/event-stream`, `Cache-Control: no-store`, buffering disabled |
| `POST /v1/room/{roomId}/up?peer=<id>` | 202 | `{"ok":true}` |

Failures, all with a small `{"error":"<code>"}` body:

| Status | When |
| --- | --- |
| 404 | `roomId` is not exactly 26 characters of `A-Z2-7`; the peer is unknown (never joined, evicted or dropped); the room does not exist |
| 404 `room_unknown` | `/v2` with `mode=join`: this relay has no record of that room and no peer is in it - the answer a wrong token gets |
| 400 | the up body contains a CR (0x0D) or an LF (0x0A) byte, or is empty; `/v2`'s body names no usable mode |
| 413 | the up body is longer than `--max-frame-bytes`; a `/v2` join body is longer than 256 bytes |
| 429 | the room is at `--max-peers-per-room`; `--max-rooms` live rooms exist and this room is new; `--max-room-records` rooms are on record and this id is new; the peer exceeded its token bucket; a source address exceeded its join bucket |

`down` details:

- frame: `data: <body verbatim>\n\n` for every frame posted by ANOTHER peer of the same room;
- heartbeat: the comment line `: ping\n\n` every `--heartbeat-seconds`; it goes through the same
  bounded queue as frames, so a stalled client is still detected on a silent room;
- a second `down` for the same peer id replaces the first (a reconnect after a network blip),
  which is why a client can retry `down` without joining again.

The body is one line of JSON by convention, but the relay neither checks nor cares: it is opaque.
That is precisely why CR and LF are refused: a body containing a newline could otherwise forge an
SSE event or a comment, so the relay is the only party allowed to add line breaks to the stream.

For reference, the envelope the clients put in that body today is

```
{"v":1,"seq":7,"s":"1a2b3c4d","fid":"0011223344556677","idx":0,"last":true,"b":"<base64 slice>"}
```

The relay reads no field of it, which is why adding `v`, `seq` and `s` to the wire line needed no
relay change and why a future field will not either. The entire enforcement list is: no CR/LF byte,
not empty, at most `--max-frame-bytes`, a known peer, inside the rate limit. Sizing, so nobody has
to redo it: a maximally filled line - a full 48000 base64 characters of slice, plus a 20-digit
`seq`, a 3-digit `idx` and the 8-character `s` - is 48103 bytes, which is 17 KB inside the 65536
default.

### The join contract: `/v1` and `/v2`

`/v2` exists because the join *contract* changed, and `PROTOCOL.md` §5 puts a changed contract in
a new route rather than in a flag on the old one. The body names the mode, and the mode has **no
default**: a default would be the old silent behaviour wearing a new route's name, so a body that
names neither value is `400 bad_mode`.

- `{"mode":"create"}`: the publisher's mode. The room is recorded if this relay has never seen
  that id, and the answer carries `created`. A desktop that expected to *find* a room and reads
  `created:true` has just learned that it made one, which is the publisher's half of the same
  legible failure.
- `{"mode":"join"}`: the replica's mode. The room must be on record, or live because a peer is in
  it, and otherwise the answer is `404 room_unknown`. **This is the fix:** a wrong token derives a
  different room id, that id names nothing anybody has created, and the caller is told so instead
  of being handed a fresh empty room that looks exactly like "nobody is publishing right now".
  "Record **or** live" also keeps the fix from becoming an outage: a room that is live but
  unrecorded is one an older client made.
- `{"mode":"create"}` is not a privilege. The mode is a client's declaration and **not an
  authentication mechanism**: the relay cannot tell a phone from a desktop, anyone may ask to
  create, and in this design the token is the whole authority - whoever holds it *is* the room.
- `/v1` keeps its old meaning for clients built before `/v2`: any well-formed id is accepted, the
  room is created implicitly, and the answer has no `created`. It *does* record the room it
  created, because a new client must be able to join a room an old one made.
- Because `room_unknown` is an answer a candidate token can be tested against, joins are braked
  per source address (`--join-rate-per-second`, `--join-rate-burst`), and the derivation costs the
  guesser 600000 PBKDF2 iterations (`PROTOCOL.md` §3) per candidate. Those two are what keep a
  dictionary walk expensive. They are the mitigation, not the removal of the risk: the relay
  answers the question, so the honest statement is that the question is priced, not forbidden.

## Rooms, peers and eviction

- A **live** room is created by a join that may create it, and destroyed when its last peer is gone.
  Every peer, drop and eviction rule below is about a live room.
- A **record** is the id and the unix time it was last used by a join, and nothing else: no token
  (the relay has never seen one), no content, no peer, no room name. It is kept in memory and in a
  file (`--room-records-file`, default `rooms.json`, written atomically), so a relay restart does
  not turn every room that exists into an unknown one - a restart that forgot them would refuse
  every replica until a publisher connected again.
- A record **lives on after its last peer**, so a replica can still enter a room whose publisher is
  asleep, and **expires** after `--room-record-ttl-days` (default 30 days) with no join. That TTL,
  not the cap, is what keeps this metadata from accumulating: the next desktop connect re-creates
  the record.
- `--max-room-records` (default 1024) is the ledger's backstop. Once it is full, a `create` for a
  room that is not already on record is `429 too_many_rooms`, which is why it is worth sizing it
  above the number of rooms you really use. The relay also prunes the oldest records down to the
  cap on its sweep.
- The ledger is read once at startup and written by the sweeper (and forced on shutdown). A file
  that cannot be read is logged as an **error**, because that failure is otherwise invisible: every
  room would look unknown until a publisher re-created it. A file that cannot be *written* is
  logged too, and the relay keeps running with records in memory only.
- A source address gets `--join-rate-per-second` (default 1) refills and `--join-rate-burst`
  (default 5) joins in a row; over that it is `429 rate_limited`. The table is bounded (an attacker
  cycling addresses cannot grow it), and a device that joins once when it opens never notices.
- A peer is evicted when it has had no `up` and no live `down` for `--idle-timeout-seconds`.
- Every peer has a bounded outbound queue (`--peer-queue-bytes`). When a frame would push a
  peer's queue over that bound, THE PEER IS DROPPED: its queue is discarded, its SSE stream is
  closed and it is removed from the room. A slow consumer therefore can never block the sender or
  any other peer, and dropping one peer never harms the room.
- Because eviction and dropping are the only ways out (there is no leave route), a peer appears in
  the log either as having left after an idle timeout or as having been dropped.
- A peer id is minted on every `join`, is opaque to the relay (it is only a lookup key inside the
  room) and is not an identity: a reconnect, or a second `join`, produces a new one. Current
  length is 4 random bytes rendered as 8 lowercase hex characters (`Ids.PeerIdBytes`).

## Build, run, selftest

```
cd remote/server
dotnet build -c Release
dotnet run -c Release -- --urls http://127.0.0.1:8787
```

`dotnet run` starts the relay in the foreground; `Ctrl+C` stops it. Every setting can come from a
flag, an environment variable or `appsettings.json`; the table and the precedence are under
Configuration below. A one room session by hand, with a room id of 26 characters from `A-Z2-7`:

```
ROOM=PAI7J75R52MFNAJYKHRT4H3HGJ
PEER=$(curl -s -X POST http://127.0.0.1:8787/v2/room/$ROOM/join -d '{"mode":"create"}' | sed 's/.*"peer":"\([^"]*\)".*/\1/')
curl -sN "http://127.0.0.1:8787/v1/room/$ROOM/down?peer=$PEER" &   # the receiving side
curl -s -X POST "http://127.0.0.1:8787/v1/room/$ROOM/up?peer=$PEER" --data-binary '{"m":1}'
```

A second peer is `-d '{"mode":"join"}'` on the same `/v2` route, and it is refused with
`{"error":"room_unknown"}` if the room above was never created. `POST /v1/room/$ROOM/join` with no
body still works and still creates the room implicitly, which is the one thing to be careful about
when you are probing by hand: a mistyped room id on `/v1` answers `200`, not `404`.

The selftest drives the whole contract in process on an ephemeral loopback port and prints a
PASS/FAIL table; the exit code is non-zero when any case fails:

```
dotnet run -c Release -- --selftest
echo $?     # 0 = all cases passed, 1 = a case failed
```

It uses a compressed limit set so the run takes seconds instead of minutes: idle timeout 6 s,
heartbeat 1 s, peer queue 256 KiB, the join brake effectively off, and one ledger file per test
process in the temporary directory, so a run never writes into the working tree and never inherits
a ledger a previous run left behind. Everything else is at its default, and the mechanics under
test are the same ones the defaults use. The set printed in the run header is authoritative for the
run. The selftest never reads `appsettings.json` and never reads the environment: its limit set is
hard-coded, so a run is deterministic whatever sits next to the binary.

Three cases cannot be tested on one relay with one limit set - the brake, the ledger cap and the
idle teardown each need limits the other cases would be flaky under - so those three start their
own relay on their own port with their own ledger file, and the case says so in its comment.

| Selftest case | Contract bullet it covers |
| --- | --- |
| healthz shape | `GET /healthz` status, content type and the exact key set `ok,rooms,peers,uptimeMs`; join moves `peers` and `rooms` by one |
| join: valid id, invalid ids, peer cap | 200 + 8 hex chars; 404 for 25/27 chars, lowercase, `0`, punctuation, empty; 429 at `--max-peers-per-room` |
| join v2: an unknown room is refused and creates nothing | `mode=join` on a room nobody created is 404 `room_unknown`, hands out no peer id and reports no creation; healthz moves neither counter; the same id is accepted the moment `create` records it, and the `join` that follows reports `created:false` |
| join v2: a missing or bad mode is refused | 400 `bad_mode` for a missing mode, an unknown one, an empty body and a malformed one; 413 `body_too_large` over the 256-byte cap; no room and no peer from any refusal |
| join v1: still creates, and the room it made is joinable after its peers | `/v1` creates and returns `{peer}`; a `/v2` `join` enters that room; once both peers idle out the live room is gone (0 rooms, 0 peers) and the `join` still succeeds, because the record outlived them |
| room records survive a reload and age out | the ledger file is written and read back by a fresh instance (a restart does not forget a room); a record whose last use is past the TTL stops being a room, for every record, and loading prunes what it read |
| join routes are rate limited per source | on a relay whose brake is on: two joins in a row are allowed, the third is 429 `rate_limited` - including one that would otherwise have been answered - and the bucket refills after its window |
| room records are capped | on a relay with a 4-record ledger: exactly `--max-room-records` creates are accepted and the one over the cap is 429 `too_many_rooms` |
| up forwards verbatim to peers, never to the sender | fan-out to the second peer, exclusion of the sender, `text/event-stream`, `Cache-Control: no-store`, heartbeat |
| CR, LF and empty bodies are refused | 400 on CR, LF, trailing LF and empty body; nothing reaches the room; the stream still works after |
| oversize body is refused | 202 at exactly `--max-frame-bytes`, 413 one byte over |
| unknown peer is refused | 404 for a peer that never joined, for a room that does not exist, for an invalid room id, on `up` and on `down` |
| rate limit answers 429 and refills | 429 once the burst is spent, only 202 before it, refill after a pause |
| two rooms never see each other | a frame in room A reaches room A only, and the reverse |
| slow consumer is dropped, sender keeps posting | a client that stops reading is dropped while every sender post still returns 202; the drop is logged; the dropped peer is 404 afterwards; the room still accepts a new peer and delivers to it |
| last peer out tears the room down | after the last peer's stream closes and the idle timeout passes, rooms and peers are both 0 |
| room cap answers 429, existing rooms keep working | 429 for a new room at `--max-rooms`, while an existing room still accepts a peer |
| logs carry no room id and no peer id | every room id and peer id used by the run is searched for in the captured log lines; lifecycle events are present |

Response buffering is disabled in process (`IHttpResponseBodyFeature.DisableBuffering()`), which is
not observable over the wire; the selftest asserts the observable half (`text/event-stream`,
`Cache-Control: no-store`, and that a small frame arrives before the request completes).

## Configuration

Fourteen settings. Each has one flag, one environment variable and one `appsettings.json` key, and
they resolve **per key**, highest source first:

    command line  >  environment variable  >  appsettings.json  >  built-in default

Per key means per key: a file that sets two keys and a flag that sets one keeps the file's other
key, and an environment variable overrides only the key it names. The order is the implementation,
not a claim - the file and the environment are folded first (the environment provider sits after
the file provider, so it wins where both name the same key) and the flags are folded on top last.

| `appsettings.json` key | Flag | Environment | Default | Accepted range |
| --- | --- | --- | --- | --- |
| `Relay:Urls` | `--urls` | `Relay__Urls` | `http://0.0.0.0:8787` | a non-empty listen URL |
| `Relay:MaxPeersPerRoom` | `--max-peers-per-room` | `Relay__MaxPeersPerRoom` | `16` | 1..1024 |
| `Relay:MaxRooms` | `--max-rooms` | `Relay__MaxRooms` | `64` | 1..65536 |
| `Relay:MaxFrameBytes` | `--max-frame-bytes` | `Relay__MaxFrameBytes` | `65536` | 1..16777216 |
| `Relay:RatePerSecond` | `--rate-per-second` | `Relay__RatePerSecond` | `60` | 0.001..1000000 |
| `Relay:RateBurst` | `--rate-burst` | `Relay__RateBurst` | `120` | 1..1000000 |
| `Relay:PeerQueueBytes` | `--peer-queue-bytes` | `Relay__PeerQueueBytes` | `4194304` | 1024..1099511627776 |
| `Relay:IdleTimeoutSeconds` | `--idle-timeout-seconds` | `Relay__IdleTimeoutSeconds` | `90` | 1..86400 |
| `Relay:HeartbeatSeconds` | `--heartbeat-seconds` | `Relay__HeartbeatSeconds` | `15` | 1..3600 |
| `Relay:RoomRecordTtlDays` | `--room-record-ttl-days` | `Relay__RoomRecordTtlDays` | `30` | 1..3650 |
| `Relay:MaxRoomRecords` | `--max-room-records` | `Relay__MaxRoomRecords` | `1024` | 1..1000000 |
| `Relay:RoomRecordsFile` | `--room-records-file` | `Relay__RoomRecordsFile` | `rooms.json` | a non-empty file name |
| `Relay:JoinRatePerSecond` | `--join-rate-per-second` | `Relay__JoinRatePerSecond` | `1` | 0.001..1000000 |
| `Relay:JoinRateBurst` | `--join-rate-burst` | `Relay__JoinRateBurst` | `5` | 1..1000000 |

The key is the PascalCase of the flag name and the environment form replaces every `:` with `__`
(the standard ASP.NET mapping), which is the whole mapping: `--max-peers-per-room` is
`Relay:MaxPeersPerRoom` is `Relay__MaxPeersPerRoom`. Both `--flag value` and `--flag=value` are
accepted. `--selftest` and `--help` are not settings.

`Relay:RateBurst` is the burst the contract's "60 with burst 120" refers to; it is configurable so
an operator can trade a longer run of back-to-back posts against a shorter one. Keep
`Relay:HeartbeatSeconds` well below `Relay:IdleTimeoutSeconds`, and keep the reverse proxy's read
timeout well above `Relay:HeartbeatSeconds`.

`Relay:JoinRateBurst` and `Relay:JoinRatePerSecond` are the join brake, per source address; they
are separate from the frame rate above on purpose, because they bound a different thing (see the
join contract). `Relay:RoomRecordsFile` is resolved beside the executable the way `appsettings.json`
is - a relative name, not a relative path - so the ledger of which rooms exist lands in the
directory holding the binary unless you root it (`--room-records-file /var/lib/spinney/rooms.json`).
The process needs write access to that directory. If it does not have it, the relay starts, logs
`room records could not be written …`, and keeps the records in memory only, which means a restart
forgets every room until a publisher connects again.

`appsettings.json` in this folder is the file that ships: the project copies it to the output and
the publish directory, and its values are the built-in defaults, so installing it changes nothing.
It is looked up from `AppContext.BaseDirectory` - the directory of the EXECUTABLE, not the working
directory, so a service started from anywhere still finds it. The file is optional: when it is
missing the startup line says so and the built-in defaults stay in force. `reloadOnChange` is off,
so the file is read once, at startup; a relay's limits do not move under it because somebody
edited a file nobody announced.

A value that cannot be parsed, or that falls outside its range, fails the start with a message
naming the key, the value and the range, and exit code 2 - from the file, from the environment and
from a flag alike, because all three go through the same validation:

```
Relay:MaxRooms (Relay__MaxRooms) expects 1..65536, got '99999'
Relay:HeartbeatSeconds (Relay__HeartbeatSeconds) expects a whole number in 1..3600, got 'soon'
```

Nothing is clamped, and a malformed `appsettings.json` refuses to start instead of starting on
defaults:

```
appsettings.json could not be read: Failed to load configuration from file '.../appsettings.json'.
```

**The trap to know about:** the configuration system ignores an unknown or misspelled key
silently, with no warning anywhere. `"MaxRoom": 8` (one `s` short) starts the relay on the default
64 rooms and says nothing about it; only the startup line shows the truth. The same is true of a
value that is not a scalar - `"MaxRooms": { "nested": 1 }` reads as absent, not as an error. There
is deliberately no unknown-key check, so the table above has to be exact.

Two more facts worth knowing:

- The standard ASP.NET variables that look like they should move the listener do not:
  `ASPNETCORE_URLS` is ignored, because the relay sets its address from `Relay:Urls` / `--urls`
  explicitly. Use `Relay:Urls`, `Relay__Urls` or `--urls`.
- `--selftest` and `--help` never read the file and never read the environment.

## Cross-compiled linux-x64 build (Native AOT)

```
cd remote/server
dotnet publish -r linux-x64 -c Release
```

Artifact: `remote/server/bin/Release/net10.0/linux-x64/publish/spinney-relay`
(about 13 MB, a self-contained x86-64 ELF; no .NET runtime needed on the target).

Copy that file to the server, and, if you configure through the file, `appsettings.json` beside
it; delete or archive `spinney-relay.dbg` (about 58 MB of debug symbols) instead of shipping it -
it is not needed to run. See the publish listing below: the publish directory holds exactly
`spinney-relay`, `appsettings.json` and the symbol sidecar.

The cross-compile uses the `StuDev.AotAnywhere` MSBuild **Sdk** (not a `PackageReference`; NuGet
cannot restore the packages that a package's own build targets declare), pinned in
`SpinneyRelay.csproj` and `global.json`. It links through zig, which the package brings with it.
See the toolchain section below for what was actually measured.

`--urls` is the only argument the published binary needs:

```
./spinney-relay --urls http://127.0.0.1:8787
```

`InvariantGlobalization=true` is set on purpose: without it a cross-compiled binary needs the ICU
library on the target machine, and the relay does no culture-sensitive work. The price is that
culture-specific formatting, sorting and casing are unavailable; the relay formats nothing but
integers and hex.

## Deployment run-book (VPS)

Terminate TLS in a reverse proxy and keep the relay on loopback. The relay itself speaks plain
HTTP only: it has no TLS, no auth, and no per-IP limit of its own on frames. The join routes are
the one address-keyed exception, and it is a brake on token guessing rather than a substitute for
the proxy's own limits.

1. Install the binary and a service account.

   ```
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin spinney
   sudo install -o root -g root -m 0755 spinney-relay /usr/local/bin/spinney-relay
   sudo install -o root -g root -m 0644 appsettings.json /usr/local/bin/appsettings.json   # optional
   ```

   `appsettings.json` has to sit in the executable's own directory (`/usr/local/bin`), which is
   unusual for a configuration file. If you would rather keep configuration in `/etc`, pass the
   values as systemd `Environment=` lines instead - see the unit below.

   The ledger of which rooms exist (`rooms.json`) is resolved the same way, so the unit below
   passes `--room-records-file /var/lib/spinney/rooms.json` and creates that directory with
   `StateDirectory=spinney`. A ledger left beside the executable is the thing to avoid:
   `/usr/local/bin` is read-only under `ProtectSystem=strict`, so the relay logs
   `room records could not be written` and forgets every room on the next restart. A ledger on a
   `tmpfs`, or inside `PrivateTmp`, is forgotten by every restart just as silently.
   `Environment=Relay__RoomRecordsFile=…` is the equivalent when you configure through the
   environment.

2. Run it under systemd (`/etc/systemd/system/spinney-relay.service`):

   ```ini
   [Unit]
   Description=spinney-relay
   After=network-online.target
   Wants=network-online.target

   [Service]
   ExecStart=/usr/local/bin/spinney-relay --urls http://127.0.0.1:8787 --room-records-file /var/lib/spinney/rooms.json
   User=spinney
   Group=spinney
   StateDirectory=spinney
   Restart=always
   RestartSec=2
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true
   LimitNOFILE=65536

   [Install]
   WantedBy=multi-user.target
   ```

   ```
   sudo systemctl daemon-reload
   sudo systemctl enable --now spinney-relay
   sudo systemctl status spinney-relay
   curl -s http://127.0.0.1:8787/healthz
   ```

   The unit binds a port above 1024, so no capability is needed. `Restart=always` is safe: the
   relay's only durable state is the ledger of room ids, which it writes as it goes, so a restart
   costs the live connections (clients reconnect) and nothing else. Look for
   `room records: N loaded from …` in the journal to confirm the ledger was found: when that line
   says `0`, or a `room records could not be read` error follows it, every replica is refused until
   a publisher connects again.

   Two things that bite during setup, both measured rather than guessed:

   - **The start limit stops you before the relay does.** systemd refuses further starts after
     `StartLimitBurst` attempts inside `StartLimitIntervalSec`, so a run of quick
     `systemctl restart`s — normal while you are wiring the unit up — leaves it `failed` with
     `start request repeated too quickly`. `systemctl reset-failed spinney-relay` clears it. It
     is systemd rate-limiting you, not the relay refusing to start.
   - **Size `MemoryMax` for the largest frame, not for the idle process.** The relay idles at
     about 10 MiB, but one maximal `MaxFrameBytes` (16 MiB) fanned out to every peer of a room
     is 240 MiB at sixteen peers, before the per-peer queues. A cap that only fits the idle
     process turns an ordinary large send into an OOM kill; give it a gigabyte and it has room
     to be wrong.

   **Updating an existing deployment** is not the same as the first install, in two ways that
   cost an evening if you meet them for the first time in a hurry:

   - **Never write over the running executable.** `scp` to `/opt/spinney-relay/spinney-relay`
     fails with `dest open … Failure` while the service runs: writing to a file that is being
     executed is `ETXTBSY`. Upload beside it and rename, which swaps the directory entry while
     the running process keeps the old inode, then restart:

     ```
     scp spinney-relay root@host:/opt/spinney-relay/spinney-relay.new
     ssh root@host 'cd /opt/spinney-relay && chmod 755 spinney-relay.new && chown spinney:spinney spinney-relay.new \
       && mv -f spinney-relay.new spinney-relay && systemctl restart spinney-relay'
     ```

   - **Publish cleanly, and compare hashes to know that you did.** The Native AOT output is
     byte-reproducible — two forced relinks of one source produce the same sha256 and the same
     ELF BuildID — so comparing the deployed file's hash with a fresh build is a real test of
     "is the server current". It is only a real test if the build was clean: an *incremental*
     `dotnet publish` reuses intermediates and can produce a different binary from the same
     source, which looks exactly like a stale deployment. Delete
     `obj/Release/net10.0/linux-x64/native` and the publish directory when the answer matters,
     and record the artifact's sha when you collect it (`node tools/collect-artifacts.mjs`).

   To configure without a file, add `Environment=` lines naming the environment form of the key,
   for example `Environment=Relay__MaxRooms=32` for `Relay:MaxRooms`. Precedence still holds
   there: a flag in `ExecStart` beats an `Environment=` line, which beats the file.

3. Put TLS in front. The SSE endpoints are long-lived responses that must not be buffered and must
   not be cut by a read timeout, or a client will look connected while receiving nothing.

   Caddy (`/etc/caddy/Caddyfile`):

   ```
   relay.example.com {
       reverse_proxy 127.0.0.1:8787 {
           flush_interval -1
       }
   }
   ```

   `flush_interval -1` is the important part: it flushes every write immediately instead of
   holding a buffer. Caddy obtains and renews the certificate for the host automatically.

   nginx:

   ```nginx
   server {
       listen 443 ssl;
       server_name relay.example.com;
       ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

       location / {
           proxy_pass http://127.0.0.1:8787;
           proxy_http_version 1.1;
           proxy_set_header Connection "";
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $remote_addr;

           proxy_buffering off;
           proxy_cache off;
           gzip off;
           proxy_read_timeout 3600s;
           proxy_send_timeout 3600s;
           client_max_body_size 1m;
       }
   }
   ```

   The details that matter for SSE:

   - `proxy_buffering off` and `gzip off` - a proxy that buffers or compresses a stream delays
     frames until its buffer fills, and a heartbeat is far too small to fill one. The relay also
     answers with `X-Accel-Buffering: no` (which nginx honours) and `Cache-Control: no-store`, but
     the directive is still the documented way to say it.
   - `proxy_read_timeout` / `proxy_send_timeout` far above `--heartbeat-seconds` (a quiet room
     sends 4 bytes every 15 s). If the proxy's read timeout is shorter than the heartbeat gap, the
     proxy closes an idle-but-healthy stream.
   - `client_max_body_size` a little above `--max-frame-bytes`, so the proxy refuses an absurd
     body before the relay has to read it.
   - HTTP/1.1 with `Connection ""`, so the upstream connection is not marked for closing.

4. Monitor with `/healthz` over loopback (`rooms`, `peers`, `uptimeMs`). It is the one route that
   is cheap to poll and needs no credential.

## Observability

Logged (counts and lifecycle only): startup and the effective limits, room created/destroyed with
the live room count, peer joined/left/dropped with the room's peer count, the room records as they
are loaded, created, aged out, capped or refused, and request failures as status + method + route
template.

Never logged: a frame body, a request or query string, a room id in full, a peer id, a source
address. A room id appears only as an 8-hex-character SHA-256 tag, which is what lets an operator
correlate the lines of one room without the log holding a credential. The `--selftest` run asserts
this against every room id and peer id it used.

The ledger file path *is* logged - it is the one path an operator has to know about, and it holds
no credential - but not the ids inside it.

`Microsoft.AspNetCore` logging is filtered to Warning, because the framework's own request logging
would print the request path - and the path holds the room id.

## Files

| File | Concern |
| --- | --- |
| `Program.cs` | entry point: parse, dispatch to selftest or host, load the file before the host exists |
| `CommandLine.cs` | flag parsing, key-by-key precedence resolution, usage text, limit summary |
| `RelayKeys.cs` | the fourteen settings in one place: key, flag, environment form, accepted range, and raw-value parsing |
| `ConfigurationSources.cs` | the `appsettings.json` and environment layers, and their error shaping |
| `Limits.cs` | the limit values, defaults, selftest sets |
| `appsettings.json` | the shipped configuration file: the defaults, documented by being them |
| `RelayApp.cs` | host wiring, logging providers, request-error middleware, ledger load and final flush |
| `RelayEndpoints.cs` | the route table |
| `HealthEndpoint.cs`, `JoinEndpoint.cs`, `JoinV2Endpoint.cs`, `DownEndpoint.cs`, `UpEndpoint.cs` | one route family each |
| `HttpJson.cs` | the small JSON writer and the route/query/source-address readers |
| `JsonContracts.cs` | response records, the join body and ledger records, and the source-generated `JsonSerializerContext` |
| `RoomRegistry.cs` | room/peer admission, the join modes, eviction, drop, counts |
| `Room.cs` | one room's peer set and its admission cap |
| `RoomRecords.cs` | which rooms exist: the ledger in memory and in its file, its TTL and its cap |
| `JoinLimiter.cs` | the per-source-address brake on the join routes |
| `Peer.cs` | one peer's liveness, bounded queue, bucket and down-stream lifetime |
| `PeerOutbox.cs` | the byte-bounded outbound queue |
| `TokenBucket.cs` | the per-peer (and per-address) rate limit |
| `RoomId.cs`, `Ids.cs` | room-id validation, peer-id generation |
| `FrameReader.cs` | read one up body, refuse CR/LF, empty or oversize, render the SSE line |
| `RelayLog.cs` | source-generated log events, and the room-id tag |
| `RelaySweeper.cs` | the 1 s sweep: eviction, teardown, record aging, quiet join sources |
| `SelfTest.cs`, `SelfTestCases.cs`, `SelfTestFixture.cs`, `SseTestClient.cs`, `SilentDown.cs`, `Check.cs`, `RecordingLoggerProvider.cs` | the in-process contract run and its helpers |

No reflection, no dynamic code, no `System.Text.Json` without the source-generated context, no
`Emit`: everything here is AOT-clean by construction, and the build reports zero trim and AOT
warnings.

## Toolchain findings: Windows host to linux-x64

Verified on this machine (.NET SDK 10.0.201, zig 0.16.0 on PATH, Windows x64):

- The recipe works: `<Sdk Name="StuDev.AotAnywhere" Version="1.0.5" />` as a direct child of
  `<Project>` in a `Microsoft.NET.Sdk.Web` project with `net10.0`, `PublishAot=true` and
  `InvariantGlobalization=true`. `dotnet publish -r linux-x64 -c Release` links through zig and
  exits 0.
- A cold first restore downloads the package plus the ~479 MB `Vezel.Zig.Toolsets.win-x64`
  toolset; a publish after that takes about 14-16 s. No workload install, no LLVM, no strip tool.
- Negative control: the same project without the `Sdk` element fails in about 2 s with
  `Microsoft.NETCore.Native.Publish.targets(60,5): error : Cross-OS native compilation is not supported.`
- The artifact is a real x86-64 Linux ELF: magic `7f 45 4c 46`, `ELFCLASS64`, little-endian,
  `e_type 0x2` (`ET_EXEC`), `e_machine 0x3e`, `PT_INTERP /lib64/ld-linux-x86-64.so.2`, dynamic
  against libc/libm/libpthread/libdl. No `libcoreclr`/`libhostfxr` references, and no ICU strings -
  self-contained, and `InvariantGlobalization` really did remove the ICU dependency.
- The target needs glibc >= 2.29 (a symbol scan of the linked binary tops out at `GLIBC_2.29`):
  Debian 10+, Ubuntu 19.04+, RHEL 8+.
- The binary could NOT be executed on this machine: `wsl.exe` exists but no WSL distribution is
  installed (`wsl -l -v` prints only usage; zero entries under the `Lxss` registry keys), and no
  docker/podman. So the cross-compiled binary is byte-verified, NOT run-verified. First run on a
  real Linux host should be `--selftest`: it needs no network and proves the binary starts, binds
  and serves.
- `global.json` is not required for the cross-compile (a preview SDK also worked) but it is pinned
  here for a reproducible build.
- `EnableDefaultContentItems=false` and `StaticWebAssetsEnabled=false` keep the publish directory
  to just the executable: otherwise the Web SDK's content glob copies `global.json` and a
  `staticwebassets.endpoints.json` next to the binary.

## Security

- The relay learns traffic shape and room ids: how many peers a room has, how large the frames are,
  how often they flow. It learns nothing about their content, because it never parses one. It also
  now **stores** which room ids exist, in the ledger file, until each ages out. If that metadata
  matters, run your own relay; that is what self-hosting is for.
- The room id is the credential. Anyone who knows it can join the room, read every frame and inject
  their own. Treat it like a password: share it over a channel you already trust, and rotate by
  starting a new room. 26 characters of base32 is 130 bits, so it is not guessable, but it is not
  secret if you paste it into a chat that is logged somewhere.
- Put TLS in front. Without it, everything above - room ids included - crosses the network in the
  clear.
- End-to-end confidentiality is the client's job. The relay is a byte pipe by design, so the frames
  should already be encrypted and authenticated by the peers; the relay's guarantees end at "the
  bytes arrived".
- **`/v2`'s mode is not a security boundary.** `mode=create` is open to anyone, and the relay
  cannot tell a phone from a desktop: whoever holds the token *is* the room. What `mode=join` buys
  is a legible answer, not a closed door.
- What the relay resists on its own: SSE injection (CR/LF refusal makes a forged event line
  impossible), oversize bodies, per-peer floods (token bucket), repeated joins from one address
  (the join brake), one peer starving the others (bounded queues drop the slow peer), and a socket
  held open forever (idle eviction).
- What it does not: `room_unknown` is an answer a candidate token can be tested against, so the
  join routes are an oracle - a priced one, since each guess costs the asker 600000 PBKDF2
  iterations and the brake slows the asking down, but an oracle all the same. An attacker can still
  fill `--max-rooms` with rooms and `--max-room-records` with records and deny new ones. There is no
  ban list, no IP allowlist, no per-IP concurrency limit; do those at the proxy or the firewall.
