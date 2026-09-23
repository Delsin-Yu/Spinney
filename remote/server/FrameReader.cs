using System.Buffers;

namespace SpinneyRelay;

internal enum FrameStatus
{
    Ok,
    Empty,
    TooLarge,
    Newline,
}

internal static class FrameReader
{
    private static readonly byte[] DataPrefix = "data: "u8.ToArray();

    public static async ValueTask<(FrameStatus Status, byte[]? Segment)> ReadAsync(Stream body, int maxFrameBytes, CancellationToken cancellationToken)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(maxFrameBytes + 1);
        try
        {
            var count = 0;
            while (true)
            {
                var read = await body.ReadAsync(buffer.AsMemory(count, maxFrameBytes + 1 - count), cancellationToken);
                if (read == 0) break;
                if (buffer.AsSpan(count, read).IndexOfAny((byte)'\r', (byte)'\n') >= 0) return (FrameStatus.Newline, null);
                count += read;
                if (count > maxFrameBytes) return (FrameStatus.TooLarge, null);
            }

            if (count == 0) return (FrameStatus.Empty, null);

            var segment = new byte[DataPrefix.Length + count + 2];
            DataPrefix.CopyTo(segment, 0);
            buffer.AsSpan(0, count).CopyTo(segment.AsSpan(DataPrefix.Length));
            segment[^2] = (byte)'\n';
            segment[^1] = (byte)'\n';
            return (FrameStatus.Ok, segment);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }
}
