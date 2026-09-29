namespace SpinneyRelay;

internal static class SelfTest
{
    public static async Task<int> RunAsync()
    {
        var cases = new (string Name, Func<SelfTestFixture, Task<Check>> Run)[]
        {
            ("healthz shape", SelfTestCases.HealthShapeAsync),
            ("join: valid id, invalid ids, peer cap", SelfTestCases.JoinAsync),
            ("join v2: an unknown room is refused and creates nothing", SelfTestCases.JoinUnknownRoomAsync),
            ("join v2: a missing or bad mode is refused", SelfTestCases.JoinModeRejectedAsync),
            ("join v1: still creates, and the room it made is joinable after its peers", SelfTestCases.LegacyJoinAsync),
            ("room records survive a reload and age out", SelfTestCases.RoomRecordPersistenceAsync),
            ("join routes are rate limited per source", SelfTestCases.JoinBrakeAsync),
            ("room records are capped", SelfTestCases.RoomRecordCapAsync),
            ("up forwards verbatim to peers, never to the sender", SelfTestCases.FanOutAsync),
            ("CR, LF and empty bodies are refused", SelfTestCases.NewlineRejectedAsync),
            ("oversize body is refused", SelfTestCases.OversizeRejectedAsync),
            ("unknown peer is refused", SelfTestCases.UnknownPeerAsync),
            ("rate limit answers 429 and refills", SelfTestCases.RateLimitAsync),
            ("two rooms never see each other", SelfTestCases.RoomIsolationAsync),
            ("slow consumer is dropped, sender keeps posting", SelfTestCases.SlowConsumerDroppedAsync),
            ("last peer out tears the room down", SelfTestCases.TeardownAsync),
            ("room cap answers 429, existing rooms keep working", SelfTestCases.RoomCapAsync),
            ("logs carry no room id and no peer id", SelfTestCases.LogHygieneAsync),
        };

        Console.WriteLine("spinney-relay selftest");
        Console.WriteLine($"limits: {CommandLine.Describe(Limits.SelfTest)}");

        await using var fixture = await SelfTestFixture.StartAsync();
        Console.WriteLine($"base address: {fixture.BaseAddress}");
        Console.WriteLine();

        var width = cases.Max(entry => entry.Name.Length);
        Console.WriteLine($"{new string('-', width + 8)}");
        var failed = 0;
        foreach (var (name, run) in cases)
        {
            Check check;
            try
            {
                check = await run(fixture);
            }
            catch (Exception exception)
            {
                check = Check.FromException(exception);
            }

            if (!check.Passed) failed++;
            Console.WriteLine($"{name.PadRight(width)}  {(check.Passed ? "PASS" : "FAIL")}");
            foreach (var failure in check.Failures) Console.WriteLine($"  {name.PadRight(width)}  - {failure}");
            Console.Out.Flush();
        }

        Console.WriteLine($"{new string('-', width + 8)}");
        Console.WriteLine();
        Console.WriteLine($"{cases.Length} cases, {cases.Length - failed} passed, {failed} failed");
        return failed == 0 ? 0 : 1;
    }
}
