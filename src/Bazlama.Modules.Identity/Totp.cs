using System.Security.Cryptography;
using System.Text;
using QRCoder;

namespace Bazlama.Modules.Identity;

/// <summary>RFC 6238 time-based one-time passwords (SHA-1, 6 digits, 30 s): what authenticator apps use.</summary>
public static class Totp
{
    const int Digits = 6;
    const int StepSeconds = 30;

    public static byte[] NewSecret() => RandomNumberGenerator.GetBytes(20);

    public static long StepAt(DateTimeOffset time) => time.ToUnixTimeSeconds() / StepSeconds;

    public static string Code(byte[] secret, long step)
    {
        Span<byte> counter = stackalloc byte[8];
        System.Buffers.Binary.BinaryPrimitives.WriteInt64BigEndian(counter, step);
        Span<byte> hash = stackalloc byte[20];
        HMACSHA1.HashData(secret, counter, hash);
        var offset = hash[^1] & 0x0f;
        var value = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
        return (value % 1_000_000).ToString("D6");
    }

    /// <summary>
    /// The matching time step (current ±1, for clock drift), or null. Steps not after
    /// <paramref name="lastUsedStep"/> are rejected: a code works once.
    /// </summary>
    public static long? Verify(byte[] secret, string code, DateTimeOffset now, long? lastUsedStep)
    {
        code = code.Replace(" ", "");
        if (code.Length != Digits || !code.All(char.IsAsciiDigit)) return null;
        var current = StepAt(now);
        for (var step = current - 1; step <= current + 1; step++)
        {
            if (lastUsedStep is { } last && step <= last) continue;
            if (CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Code(secret, step)), Encoding.ASCII.GetBytes(code)))
                return step;
        }
        return null;
    }

    public static string OtpAuthUri(byte[] secret, string issuer, string account) =>
        $"otpauth://totp/{Uri.EscapeDataString(issuer)}:{Uri.EscapeDataString(account)}" +
        $"?secret={Base32.Encode(secret)}&issuer={Uri.EscapeDataString(issuer)}&digits={Digits}&period={StepSeconds}";

    public static string QrSvg(string text)
    {
        using var generator = new QRCodeGenerator();
        using var data = generator.CreateQrCode(text, QRCodeGenerator.ECCLevel.M);
        return new SvgQRCode(data).GetGraphic(4);
    }
}

/// <summary>RFC 4648 base32 (no padding): how authenticator apps take the secret.</summary>
public static class Base32
{
    const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    public static string Encode(ReadOnlySpan<byte> data)
    {
        var sb = new StringBuilder((data.Length * 8 + 4) / 5);
        int buffer = 0, bits = 0;
        foreach (var b in data)
        {
            buffer = (buffer << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                sb.Append(Alphabet[(buffer >> (bits - 5)) & 31]);
                bits -= 5;
            }
        }
        if (bits > 0) sb.Append(Alphabet[(buffer << (5 - bits)) & 31]);
        return sb.ToString();
    }

    public static byte[] Decode(string text)
    {
        var result = new List<byte>(text.Length * 5 / 8);
        int buffer = 0, bits = 0;
        foreach (var c in text.TrimEnd('=').ToUpperInvariant())
        {
            var v = Alphabet.IndexOf(c);
            if (v < 0) throw new FormatException($"Not base32: '{c}'.");
            buffer = (buffer << 5) | v;
            bits += 5;
            if (bits >= 8)
            {
                result.Add((byte)(buffer >> (bits - 8)));
                bits -= 8;
            }
        }
        return [.. result];
    }
}
