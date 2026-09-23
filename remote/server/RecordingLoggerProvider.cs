using System.Collections.Concurrent;

namespace SpinneyRelay;

internal sealed class RecordingLoggerProvider : ILoggerProvider
{
    private readonly ConcurrentQueue<string> _messages = new();

    public IReadOnlyList<string> Snapshot() => _messages.ToArray();

    public ILogger CreateLogger(string categoryName) => new Recorder(_messages);

    public void Dispose()
    {
    }

    private sealed class Recorder(ConcurrentQueue<string> sink) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            sink.Enqueue($"{logLevel}: {formatter(state, exception)}");
    }
}
