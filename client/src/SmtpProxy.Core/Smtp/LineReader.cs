using System.Text;

namespace SmtpProxy.Core.Smtp;

/// <summary>Buffered reader for SMTP: command lines as text, the DATA section as raw bytes.</summary>
internal sealed class LineReader(Stream stream)
{
    readonly byte[] _buf = new byte[16 * 1024];
    int _pos, _len;

    async Task<bool> FillAsync(CancellationToken ct)
    {
        if (_pos < _len) return true;
        _pos = 0;
        _len = await stream.ReadAsync(_buf, ct);
        return _len > 0;
    }

    /// <summary>Next line without CRLF, null at end of stream. Lines longer than maxLength throw.</summary>
    public async Task<string?> ReadLineAsync(int maxLength, CancellationToken ct)
    {
        var line = new MemoryStream();
        while (true)
        {
            if (!await FillAsync(ct)) return line.Length > 0 ? Encoding.UTF8.GetString(line.ToArray()) : null;
            var idx = Array.IndexOf(_buf, (byte)'\n', _pos, _len - _pos);
            var end = idx < 0 ? _len : idx;
            line.Write(_buf, _pos, end - _pos);
            _pos = idx < 0 ? _len : idx + 1;
            if (line.Length > maxLength) throw new SmtpLineTooLongException();
            if (idx >= 0)
            {
                var bytes = line.ToArray();
                var n = bytes.Length > 0 && bytes[^1] == '\r' ? bytes.Length - 1 : bytes.Length;
                return Encoding.UTF8.GetString(bytes, 0, n);
            }
        }
    }

    /// <summary>
    /// Reads the DATA section up to the terminating "." line, removes dot stuffing and normalises line ends to CRLF.
    /// Returns null if the message exceeds maxBytes (the rest is still consumed).
    /// </summary>
    public async Task<byte[]?> ReadDataAsync(long maxBytes, CancellationToken ct)
    {
        var data = new MemoryStream();
        var tooLarge = false;
        var line = new MemoryStream();
        while (true)
        {
            if (!await FillAsync(ct)) throw new EndOfStreamException();
            var idx = Array.IndexOf(_buf, (byte)'\n', _pos, _len - _pos);
            var end = idx < 0 ? _len : idx;
            // once too large, only the start of a line is kept (enough to see the terminating ".")
            if (!tooLarge || line.Length < 4) line.Write(_buf, _pos, end - _pos);
            if (!tooLarge && line.Length > maxBytes) { tooLarge = true; data = new MemoryStream(); }
            _pos = idx < 0 ? _len : idx + 1;
            if (idx < 0) continue;

            var b = line.GetBuffer();
            var n = (int)line.Length;
            if (n > 0 && b[n - 1] == '\r') n--;
            if (n == 1 && b[0] == '.') return tooLarge ? null : data.ToArray();
            var offset = n > 0 && b[0] == '.' ? 1 : 0;
            if (!tooLarge)
            {
                data.Write(b, offset, n - offset);
                data.Write("\r\n"u8);
                if (data.Length > maxBytes) { tooLarge = true; data = new MemoryStream(); }
            }
            line.SetLength(0);
        }
    }
}

internal sealed class SmtpLineTooLongException : Exception;
