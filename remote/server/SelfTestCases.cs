using System.Text;
using Microsoft.Extensions.Logging.Abstractions;

namespace SpinneyRelay;

internal static class SelfTestCases
{
    public static async Task<Check> HealthShapeAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        using var health = await fixture.HealthAsync();
        check.Equal(200, health.Status, "healthz status");
        check.Equal("application/json", health.ContentType, "healthz content type");
        check.Equal("ok,rooms,peers,uptimeMs", health.KeyList, "healthz key set and order");
        check.Equal(System.Text.Json.JsonValueKind.True, health.Root.GetProperty("ok").ValueKind, "ok is a JSON boolean");
        check.True(health.Ok, "ok is true");
        check.True(health.IsIntegral("rooms") && health.IsIntegral("peers") && health.IsIntegral("uptimeMs"), "rooms, peers and uptimeMs are integers");
        check.True(health.Rooms >= 0 && health.Peers >= 0 && health.UptimeMs >= 0, "the counters are non-negative");

        var peersBefore = health.Peers;
        var roomsBefore = health.Rooms;
        var (status, peer) = await fixture.JoinAsync(fixture.NewRoomId());
        check.Equal(200, status, "join status");
        check.True(peer is not null, "join returned a peer id");

        using var after = await fixture.HealthAsync();
        check.Equal(peersBefore + 1, after.Peers, "peers grows by one on join");
        check.Equal(roomsBefore + 1, after.Rooms, "rooms grows by one on the first join of a room");
        return check;
    }

    public static async Task<Check> JoinAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var roomId = fixture.NewRoomId();
        var (status, peer) = await fixture.JoinAsync(roomId);
        check.Equal(200, status, "a valid room id is accepted");
        check.True(peer is { Length: 8 }, $"the peer id is 8 characters (got {peer ?? "<null>"})");
        check.True(
            peer is not null && peer.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f'),
            "the peer id is lowercase hex");

        var invalid = new[]
        {
            (Value: roomId[..25], Why: "25 characters"),
            (Value: roomId + "A", Why: "27 characters"),
            (Value: roomId.ToLowerInvariant(), Why: "lowercase alphabet"),
            (Value: roomId[..25] + "0", Why: "character outside the alphabet"),
            (Value: roomId[..25] + "=", Why: "punctuation"),
            (Value: "", Why: "empty"),
        };
        foreach (var (value, why) in invalid)
        {
            if (value == roomId) continue;
            var (invalidStatus, _) = await fixture.JoinAsync(value);
            check.Equal(404, invalidStatus, $"an invalid room id is refused ({why})");
        }

        var capRoomId = fixture.NewRoomId();
        var accepted = 0;
        var lastStatus = 0;
        for (var i = 0; i < fixture.Limits.MaxPeersPerRoom + 1; i++)
        {
            var (joinStatus, _) = await fixture.JoinAsync(capRoomId);
            lastStatus = joinStatus;
            if (joinStatus == 200) accepted++;
        }

        check.Equal(fixture.Limits.MaxPeersPerRoom, accepted, "peers are accepted up to max-peers-per-room");
        check.Equal(429, lastStatus, "the peer over max-peers-per-room is refused");
        return check;
    }

    public static async Task<Check> FanOutAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var roomId = fixture.NewRoomId();
        var (_, first) = await fixture.JoinAsync(roomId);
        var (_, second) = await fixture.JoinAsync(roomId);

        await using var downSecond = await fixture.OpenDownAsync(roomId, second!);
        check.Equal(200, downSecond.StatusCode, "down status");
        check.True(
            downSecond.ContentType?.StartsWith("text/event-stream", StringComparison.Ordinal) == true,
            $"down content type is text/event-stream (got {downSecond.ContentType ?? "<null>"})");
        check.Equal("no-store", downSecond.CacheControl, "down cache-control");

        await using var downFirst = await fixture.OpenDownAsync(roomId, first!);
        check.Equal(200, downFirst.StatusCode, "down status for the sending peer");

        check.Equal(202, await fixture.PostUpAsync(roomId, first!, Bytes("{\"m\":1}")), "up status");
        check.Equal("{\"m\":1}", await downSecond.NextDataAsync(TimeSpan.FromSeconds(5)), "the other peer receives the frame verbatim");
        check.True(await downFirst.NextDataAsync(TimeSpan.FromMilliseconds(600)) is null, "the sender does not receive its own frame");

        check.Equal(202, await fixture.PostUpAsync(roomId, second!, Bytes("{\"m\":2}")), "up status from the second peer");
        check.Equal("{\"m\":2}", await downFirst.NextDataAsync(TimeSpan.FromSeconds(5)), "the first peer receives the second frame");
        check.True(await downSecond.NextDataAsync(TimeSpan.FromMilliseconds(600)) is null, "the second peer does not receive its own frame");

        var heartbeat = await fixture.WaitUntilAsync(() => Task.FromResult(downFirst.SawPing), TimeSpan.FromSeconds(6));
        check.True(heartbeat, "the heartbeat comment line arrives on an idle stream");

        var slice = new string('A', 48000);
        var envelope = $"{{\"v\":1,\"seq\":7,\"s\":\"1a2b3c4d\",\"fid\":\"0011223344556677\",\"idx\":0,\"last\":true,\"b\":\"{slice}\"}}";
        check.Equal(202, await fixture.PostUpAsync(roomId, first!, Bytes(envelope)), "a full 48000-character transport slice is accepted");
        check.Equal(envelope, await downSecond.NextDataAsync(TimeSpan.FromSeconds(5)), "the current envelope is forwarded verbatim, field for field");

        var extreme = $"{{\"v\":1,\"seq\":18446744073709551615,\"s\":\"1a2b3c4d\",\"fid\":\"ffffffffffffffff\",\"idx\":348,\"last\":true,\"b\":\"{slice}\"}}";
        check.Equal(48103, extreme.Length, "the worst-case envelope line is 48103 bytes (sizing note in README.md)");
        check.Equal(202, await fixture.PostUpAsync(roomId, first!, Bytes(extreme)), "the worst-case envelope line is accepted");
        check.Equal(extreme, await downSecond.NextDataAsync(TimeSpan.FromSeconds(5)), "the worst-case envelope is forwarded verbatim");
        return check;
    }

    public static async Task<Check> NewlineRejectedAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var roomId = fixture.NewRoomId();
        var (_, sender) = await fixture.JoinAsync(roomId);
        var (_, receiver) = await fixture.JoinAsync(roomId);
        await using var down = await fixture.OpenDownAsync(roomId, receiver!);

        check.Equal(400, await fixture.PostUpAsync(roomId, sender!, Bytes("{\"a\":1}\r{\"b\":2}")), "a CR byte in the body is refused");
        check.Equal(400, await fixture.PostUpAsync(roomId, sender!, Bytes("{\"a\":1}\n{\"b\":2}")), "an LF byte in the body is refused");
        check.Equal(400, await fixture.PostUpAsync(roomId, sender!, Bytes("{\"a\":1}\n")), "a trailing LF is refused");
        check.Equal(400, await fixture.PostUpAsync(roomId, sender!, []), "an empty body is refused");
        check.True(await down.NextDataAsync(TimeSpan.FromMilliseconds(600)) is null, "a refused body never reaches the room");

        check.Equal(202, await fixture.PostUpAsync(roomId, sender!, Bytes("{\"a\":1}")), "a single-line body is accepted");
        check.Equal("{\"a\":1}", await down.NextDataAsync(TimeSpan.FromSeconds(5)), "the stream still works after the refusals");
        return check;
    }

    public static async Task<Check> OversizeRejectedAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var roomId = fixture.NewRoomId();
        var (_, peer) = await fixture.JoinAsync(roomId);
        var max = fixture.Limits.MaxFrameBytes;

        var atLimit = new byte[max];
        Array.Fill(atLimit, (byte)'a');
        check.Equal(202, await fixture.PostUpAsync(roomId, peer!, atLimit), $"a body of exactly {max} bytes is accepted");

        var overLimit = new byte[max + 1];
        Array.Fill(overLimit, (byte)'b');
        check.Equal(413, await fixture.PostUpAsync(roomId, peer!, overLimit), $"a body of {max + 1} bytes is refused");
        return check;
    }

    public static async Task<Check> UnknownPeerAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var roomId = fixture.NewRoomId();
        var (_, peer) = await fixture.JoinAsync(roomId);
        var ghost = "0123456789abcdef";
        var otherRoomId = fixture.NewRoomId();

        check.Equal(404, await fixture.PostUpAsync(roomId, ghost, Bytes("{\"a\":1}")), "up from a peer that never joined");
        check.Equal(404, await fixture.PostUpAsync(otherRoomId, peer!, Bytes("{\"a\":1}")), "up into a room that does not exist");
        check.Equal(404, await fixture.PostUpAsync("not-a-room-id", peer!, Bytes("{\"a\":1}")), "up with an invalid room id");
        check.Equal(404, await fixture.DownStatusAsync(roomId, ghost), "down for a peer that never joined");
        check.Equal(404, await fixture.DownStatusAsync(otherRoomId, peer!), "down in a room that does not exist");
        return check;
    }

    public static async Task<Check> RateLimitAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var roomId = fixture.NewRoomId();
        var (_, peer) = await fixture.JoinAsync(roomId);
        var frame = Bytes("{\"m\":\"tick\"}");

        var accepted = 0;
        var firstLimitedAt = -1;
        var unexpected = 0;
        for (var i = 0; i < 1500 && firstLimitedAt < 0; i++)
        {
            var status = await fixture.PostUpAsync(roomId, peer!, frame);
            switch (status)
            {
                case 202:
                    accepted++;
                    break;
                case 429:
                    firstLimitedAt = i;
                    break;
                default:
                    unexpected++;
                    break;
            }
        }

        check.Equal(0, unexpected, "the only statuses seen are 202 and 429");
        check.True(firstLimitedAt >= 0, "the rate limit answers 429 once the bucket is empty");
        check.True(accepted >= 100, $"the burst allows at least 100 frames in a row (accepted {accepted})");
        check.True(firstLimitedAt <= (int)fixture.Limits.RateBurst + 20, $"the burst is honoured before the first 429 (first 429 at {firstLimitedAt}, burst {(int)fixture.Limits.RateBurst})");

        await Task.Delay(500);
        check.Equal(202, await fixture.PostUpAsync(roomId, peer!, frame), "the bucket refills after the burst");
        return check;
    }

    public static async Task<Check> RoomIsolationAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var roomA = fixture.NewRoomId();
        var roomB = fixture.NewRoomId();
        var (_, senderA) = await fixture.JoinAsync(roomA);
        var (_, receiverA) = await fixture.JoinAsync(roomA);
        var (_, receiverB) = await fixture.JoinAsync(roomB);

        await using var downA = await fixture.OpenDownAsync(roomA, receiverA!);
        await using var downB = await fixture.OpenDownAsync(roomB, receiverB!);

        check.Equal(202, await fixture.PostUpAsync(roomA, senderA!, Bytes("{\"room\":\"a\"}")), "up in the first room");
        check.Equal("{\"room\":\"a\"}", await downA.NextDataAsync(TimeSpan.FromSeconds(5)), "the peer of the first room receives it");
        check.True(await downB.NextDataAsync(TimeSpan.FromMilliseconds(600)) is null, "the peer of the second room never sees it");

        check.Equal(202, await fixture.PostUpAsync(roomB, receiverB!, Bytes("{\"room\":\"b\"}")), "up in the second room");
        check.True(await downA.NextDataAsync(TimeSpan.FromMilliseconds(600)) is null, "the peer of the first room never sees the second room's frame");
        return check;
    }

    public static async Task<Check> SlowConsumerDroppedAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var roomId = fixture.NewRoomId();
        var (_, sender) = await fixture.JoinAsync(roomId);
        var (_, slow) = await fixture.JoinAsync(roomId);
        await using var silent = await SilentDown.OpenAsync(fixture.Http, $"/v1/room/{roomId}/down?peer={slow}");
        check.Equal(200, silent.StatusCode, "the slow peer opened its stream and stops reading");

        var frame = new byte[64 * 1024];
        Array.Fill(frame, (byte)'x');
        var refused = new List<int>();
        for (var i = 0; i < 80; i++)
        {
            var status = await fixture.PostUpAsync(roomId, sender!, frame);
            if (status != 202) refused.Add(status);
        }

        check.True(
            refused.Count == 0,
            $"every post from the sender keeps succeeding while the slow peer is dropped (refused {refused.Count}: {string.Join(",", refused.Take(5))})");
        check.Equal(404, await fixture.PostUpAsync(roomId, slow!, Bytes("{\"a\":1}")), "the dropped peer is unknown afterwards");
        check.True(
            fixture.LogSnapshot().Any(line => line.Contains(RelayLog.Tag(roomId), StringComparison.Ordinal) && line.Contains("dropped", StringComparison.Ordinal)),
            "the drop is logged against the room tag");
        check.True(await silent.EndedAsync(TimeSpan.FromSeconds(10)), "the server closed the slow peer's stream");

        var (joinerStatus, joiner) = await fixture.JoinAsync(roomId);
        check.Equal(200, joinerStatus, "the room survives the drop and accepts a new peer");
        await using var fresh = await fixture.OpenDownAsync(roomId, joiner!);
        check.Equal(202, await fixture.PostUpAsync(roomId, sender!, Bytes("{\"alive\":1}")), "the sender still posts after the drop");
        check.Equal("{\"alive\":1}", await fresh.NextDataAsync(TimeSpan.FromSeconds(5)), "a new peer of the same room receives frames");
        return check;
    }

    public static async Task<Check> RoomCapAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var max = fixture.Limits.MaxRooms;
        var joined = 0;
        var refused = 0;
        string? lastJoined = null;
        for (var i = 0; i < max * 3 && refused == 0; i++)
        {
            var roomId = fixture.NewRoomId();
            var (status, _) = await fixture.JoinAsync(roomId);
            if (status == 200)
            {
                joined++;
                lastJoined = roomId;
                continue;
            }

            refused = status;
        }

        check.Equal(429, refused, "a room over max-rooms is refused");
        check.True(joined >= 1, "at least one room was created in this case");
        using (var health = await fixture.HealthAsync())
        {
            check.True(
                health.Rooms <= max && health.Rooms >= max - 1,
                $"live rooms sit at max-rooms when the cap is hit (rooms {health.Rooms}, max-rooms {max})");
        }

        if (lastJoined is not null)
        {
            var (existingStatus, _) = await fixture.JoinAsync(lastJoined);
            check.Equal(200, existingStatus, "an existing room still accepts a peer while the room cap is hit");
        }

        return check;
    }

    public static async Task<Check> TeardownAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var roomId = fixture.NewRoomId();
        var (status, peer) = await fixture.JoinAsync(roomId);
        check.Equal(200, status, "join of a fresh room");
        if (status != 200 || peer is null) return check;

        await using (var down = await fixture.OpenDownAsync(roomId, peer))
        {
            check.Equal(200, down.StatusCode, "down");
        }

        var drained = await fixture.WaitUntilAsync(
            async () =>
            {
                using var health = await fixture.HealthAsync();
                return health.Rooms == 0 && health.Peers == 0;
            },
            TimeSpan.FromSeconds(45));

        using var final = await fixture.HealthAsync();
        check.True(
            drained,
            $"every room and peer is gone once the last peer idled out (rooms {final.Rooms}, peers {final.Peers})");
        return check;
    }

    public static Task<Check> LogHygieneAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var messages = fixture.LogSnapshot();
        check.True(messages.Count > 0, "the relay logged lifecycle events");
        check.True(messages.Any(line => line.Contains("created", StringComparison.Ordinal)), "room creation is logged");
        check.True(messages.Any(line => line.Contains("dropped", StringComparison.Ordinal)), "a dropped peer is logged");
        check.True(messages.Any(line => line.Contains("left", StringComparison.Ordinal)), "an idle peer is logged as having left");
        check.True(messages.Any(line => line.Contains("destroyed", StringComparison.Ordinal)), "room destruction is logged");

        var leaks = new List<string>();
        foreach (var message in messages)
        {
            foreach (var roomId in fixture.RoomIds)
            {
                if (message.Contains(roomId, StringComparison.Ordinal)) leaks.Add($"room id in \"{message}\"");
            }

            foreach (var peerId in fixture.PeerIds)
            {
                if (message.Contains(peerId, StringComparison.Ordinal)) leaks.Add($"peer id in \"{message}\"");
            }
        }

        check.True(leaks.Count == 0, $"no full room id and no peer id appears in a log line: {string.Join(" | ", leaks.Take(3))}");
        return Task.FromResult(check);
    }

    /// <summary>
    /// The headline of this round: a join that may only enter (`mode=join`) is refused for a room
    /// nobody has created — and refusing it creates nothing, no room, no record, no peer. This is
    /// the case that turns a wrong token into a sentence instead of an empty room that looks
    /// exactly like "nobody is publishing right now".
    /// </summary>
    public static async Task<Check> JoinUnknownRoomAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var roomId = fixture.NewRoomId();
        using var before = await fixture.HealthAsync();

        var (status, peer, created, error) = await fixture.JoinV2Async(roomId, "join");
        check.Equal(404, status, "joining a room nobody created is refused");
        check.Equal("room_unknown", error, "the refusal names its reason");
        check.True(peer is null, "a refused join hands out no peer id");
        check.True(!created, "a refused join reports no creation");

        using (var after = await fixture.HealthAsync())
        {
            check.Equal(before.Rooms, after.Rooms, "the refused join left no live room behind");
            check.Equal(before.Peers, after.Peers, "the refused join left no peer behind");
        }

        // The same id works the moment a publisher creates it: the refusal was about existence,
        // not about the id.
        var (createStatus, owner, wasCreated, createError) = await fixture.JoinV2Async(roomId, "create");
        check.Equal(200, createStatus, $"create accepts the same room id (error {createError ?? "none"})");
        check.True(wasCreated, "the first create says the room is new");
        check.True(owner is not null, "create returned a peer id");

        var (joinStatus, replica, joinCreated, joinError) = await fixture.JoinV2Async(roomId, "join");
        check.Equal(200, joinStatus, $"join enters the room that now exists (error {joinError ?? "none"})");
        check.True(!joinCreated, "a join never reports a creation");
        check.True(replica is not null, "join returned a peer id");

        using (var after = await fixture.HealthAsync())
        {
            check.Equal(before.Rooms + 1, after.Rooms, "exactly one room exists after the create");
            check.Equal(before.Peers + 2, after.Peers, "and both callers are in it");
        }

        return check;
    }

    /// <summary>
    /// The mode is required and has no default: a request without a legible one is refused, rather
    /// than answered with the old silent behaviour under a new route's name.
    /// </summary>
    public static async Task<Check> JoinModeRejectedAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var roomId = fixture.NewRoomId();
        using var before = await fixture.HealthAsync();

        var (missingStatus, _, _, missingError) = await fixture.PostJoinV2RawAsync(roomId, Encoding.UTF8.GetBytes("{}"));
        check.Equal(400, missingStatus, "a body with no mode is refused");
        check.Equal("bad_mode", missingError, "…and it says so");

        var (wrongStatus, _, _, wrongError) = await fixture.PostJoinV2RawAsync(roomId, Encoding.UTF8.GetBytes("{\"mode\":\"create-or-join\"}"));
        check.Equal(400, wrongStatus, "an unknown mode is refused");
        check.Equal("bad_mode", wrongError, "…and it says so");

        var (emptyStatus, _, _, _) = await fixture.PostJoinV2RawAsync(roomId, [], omitContentType: true);
        check.Equal(400, emptyStatus, "an empty body is refused");

        var (brokenStatus, _, _, _) = await fixture.PostJoinV2RawAsync(roomId, Encoding.UTF8.GetBytes("{\"mode\":\"join\""));
        check.Equal(400, brokenStatus, "a malformed body is refused");

        var oversize = Encoding.UTF8.GetBytes("{\"mode\":\"join\",\"pad\":\"" + new string('x', 400) + "\"}");
        var (largeStatus, _, _, largeError) = await fixture.PostJoinV2RawAsync(roomId, oversize);
        check.Equal(413, largeStatus, "a body over the join cap is refused");
        check.Equal("body_too_large", largeError, "…and it says so");

        using (var after = await fixture.HealthAsync())
        {
            check.Equal(before.Rooms, after.Rooms, "no refused mode created a room");
            check.Equal(before.Peers, after.Peers, "no refused mode created a peer");
        }

        return check;
    }

    /// <summary>
    /// A client built before `/v2` keeps working: `/v1` still creates the room it names — and that
    /// room is *recorded*, so a phone on `/v2` can join a room an old client made, and can still
    /// join it once that client is gone.
    ///
    /// Runs on its own relay with a one-second idle timeout, because the second half is about a
    /// room whose peers have been evicted — and waiting for that must not be done by asking the
    /// relay anything that would keep the peers alive. Nothing here posts `up` after the joins.
    /// </summary>
    public static async Task<Check> LegacyJoinAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        await using var quick = await SelfTestFixture.StartAsync(Limits.SelfTestIdle);
        var roomId = quick.NewRoomId();

        var (legacyStatus, legacyPeer) = await quick.JoinAsync(roomId);
        check.Equal(200, legacyStatus, "/v1 still creates the room it names");
        check.True(legacyPeer is not null, "/v1 returned a peer id");

        var (joinStatus, phone, _, joinError) = await quick.JoinV2Async(roomId, "join");
        check.Equal(200, joinStatus, $"/v2 join enters a room /v1 created (error {joinError ?? "none"})");
        check.True(phone is not null, "the phone got a peer id");

        using (var busy = await quick.HealthAsync())
        {
            check.Equal(1, busy.Rooms, "the room is live while its peers are");
        }

        // Both peers go quiet; the sweeper evicts them and the live room is torn down. Health is
        // the only thing asked, because `up` would touch a peer and postpone exactly what is
        // being waited for.
        await Task.Delay(3500);
        using (var torn = await quick.HealthAsync())
        {
            check.Equal(0, torn.Rooms, "the live room is gone once its peers idle out");
            check.Equal(0, torn.Peers, "…and so are its peers");
        }

        var (afterStatus, _, _, afterError) = await quick.JoinV2Async(roomId, "join");
        check.Equal(200, afterStatus, $"the record outlives the peers that made it (error {afterError ?? "none"})");
        return check;
    }

    /// <summary>
    /// The record is a file, and it has to survive the process that wrote it: a relay restart must
    /// not turn every room that exists into an unknown one. Also the aging: a record past the TTL
    /// is not a room any more, which is what keeps this metadata from accumulating forever.
    /// </summary>
    public static Task<Check> RoomRecordPersistenceAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var path = Path.Combine(Path.GetTempPath(), $"spinney-selftest-{Environment.ProcessId}-roundtrip.json");
        var limits = Limits.SelfTest with { RoomRecordsFile = path };
        var logger = NullLogger<RoomRecords>.Instance;
        var roomId = fixture.NewRoomId();
        var stale = fixture.NewRoomId();

        try
        {
            var writing = new RoomRecords(limits, logger);
            writing.Load();
            check.Equal(RoomRecordOutcome.Created, writing.Ensure(roomId), "the first create makes a record");
            check.Equal(RoomRecordOutcome.Existing, writing.Ensure(roomId), "a second create finds it");
            check.True(writing.Exists(roomId), "the record is there in memory");
            writing.Save(force: true);

            var reading = new RoomRecords(limits, logger);
            reading.Load();
            check.True(reading.Exists(roomId), "the record survives a fresh load: a restart does not forget the room");

            // Aging, on a hand-written file: a record whose last use is beyond the TTL is not a room.
            var old = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - (limits.RoomRecordTtlDays + 1) * 86400L;
            File.WriteAllText(path, $"{{\"v\":1,\"rooms\":{{\"{roomId}\":{old},\"{stale}\":{old}}}}}");
            var aged = new RoomRecords(limits, logger);
            aged.Load();
            check.True(!aged.Exists(roomId), "a record past the TTL stops being a room");
            check.True(!aged.Exists(stale), "…for every record past it");
            check.Equal(0, aged.Count, "…and loading prunes what it read");
        }
        finally
        {
            foreach (var leftover in new[] { path, path + ".tmp" })
            {
                if (File.Exists(leftover)) File.Delete(leftover);
            }
        }

        return Task.FromResult(check);
    }

    /// <summary>
    /// The brake on the join routes. `room_unknown` is an answer a candidate token can be tested
    /// against, so a source that hammers joins is slowed down — while a device that joins once
    /// when it opens never notices.
    /// </summary>
    public static async Task<Check> JoinBrakeAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        await using var tight = await SelfTestFixture.StartAsync(Limits.SelfTestPairing);
        var roomId = tight.NewRoomId();

        var statuses = new List<int>();
        for (var i = 0; i < 4; i++)
        {
            var (status, _, _, _) = await tight.JoinV2Async(roomId, "create");
            statuses.Add(status);
        }

        check.Equal(200, statuses[0], "the first join is allowed");
        check.Equal(200, statuses[1], "the burst is allowed");
        check.Equal(429, statuses[2], "a join over the burst is refused");

        var (refused, _, _, error) = await tight.JoinV2Async(tight.NewRoomId(), "join");
        check.Equal(429, refused, "the brake covers a join it would otherwise have answered");
        check.Equal("rate_limited", error, "and it says so");

        // A brake, not a wall: after the refill window a join goes through again.
        await Task.Delay(1300);
        var (later, _, _, _) = await tight.JoinV2Async(roomId, "create");
        check.Equal(200, later, "the brake refills");
        return check;
    }

    /// <summary>The ledger's cap: a backstop for a relay that really does run out of room.</summary>
    public static async Task<Check> RoomRecordCapAsync(SelfTestFixture fixture)
    {
        var check = Check.New();
        var path = Limits.SelfTestLedger.RoomRecordsFile;
        foreach (var leftover in new[] { path, path + ".tmp" })
        {
            if (File.Exists(leftover)) File.Delete(leftover);
        }

        await using var tiny = await SelfTestFixture.StartAsync(Limits.SelfTestLedger);
        var created = 0;
        var refused = 0;
        string? refusedError = null;
        for (var i = 0; i < tiny.Limits.MaxRoomRecords + 1; i++)
        {
            var (status, _, _, error) = await tiny.JoinV2Async(tiny.NewRoomId(), "create");
            if (status == 200)
            {
                created++;
                continue;
            }

            refused = status;
            refusedError = error;
        }

        check.Equal(tiny.Limits.MaxRoomRecords, created, "the ledger takes exactly max-room-records rooms");
        check.Equal(429, refused, "the room over the cap is refused");
        check.Equal("too_many_rooms", refusedError, "and it says so");
        return check;
    }

    private static byte[] Bytes(string text) => Encoding.UTF8.GetBytes(text);
}
