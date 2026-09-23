namespace SpinneyRelay;

internal sealed class Check
{
    private readonly List<string> _failures = new();

    private Check()
    {
    }

    public static Check New() => new();

    public static Check FromException(Exception exception)
    {
        var check = new Check();
        check.Fail($"{exception.GetType().Name}: {exception.Message}");
        return check;
    }

    public bool Passed => _failures.Count == 0;

    public IReadOnlyList<string> Failures => _failures;

    public void True(bool condition, string message)
    {
        if (!condition) _failures.Add(message);
    }

    public void Equal<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            _failures.Add($"{message}: expected {Format(expected)}, got {Format(actual)}");
        }
    }

    public void Fail(string message) => _failures.Add(message);

    private static string Format(object? value)
    {
        if (value is null) return "<null>";
        var text = value.ToString() ?? "<null>";
        if (text.Length > 80) text = text[..80] + "...";
        return text.Replace("\r", "\\r").Replace("\n", "\\n");
    }
}
