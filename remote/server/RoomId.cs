namespace SpinneyRelay;

internal static class RoomId
{
    public const int Length = 26;

    public static bool IsValid(string? value)
    {
        if (value is null || value.Length != Length) return false;
        foreach (var character in value)
        {
            var inAlphabet = character is >= 'A' and <= 'Z' or >= '2' and <= '7';
            if (!inAlphabet) return false;
        }

        return true;
    }
}
