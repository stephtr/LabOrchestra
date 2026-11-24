using System.Runtime.InteropServices;
using System.Text;

namespace LabOrchestra.Sdk;

/// <summary>Writes a one-dimensional .npy file of a number type, a block at a time. The length in the header is filled in when the writer
/// is disposed; <see cref="NpyFile.Repair"/> does it for files a crash left behind.</summary>
public sealed class NpyWriter<T> : IDisposable where T : unmanaged
{
	private readonly Stream _stream;
	private readonly bool _closeStream;
	private bool _disposed;

	public NpyWriter(Stream stream, bool closeStream = true)
	{
		_stream = stream;
		_closeStream = closeStream;
		_stream.Write(NpyFile.Header<T>(0));
	}

	public long Count { get; private set; }

	public void Write(ReadOnlySpan<T> values)
	{
		if (_disposed) throw new ObjectDisposedException(nameof(NpyWriter<T>));
		_stream.Write(MemoryMarshal.AsBytes(values));
		Count += values.Length;
	}

	public void Flush() => _stream.Flush();

	public void Dispose()
	{
		if (_disposed) return;
		_disposed = true;
		_stream.Flush();
		_stream.Seek(0, SeekOrigin.Begin);
		_stream.Write(NpyFile.Header<T>(Count)); // same length as before: the count is padded
		if (_closeStream) _stream.Dispose();
	}
}

public static class NpyFile
{
	private const int HeaderLength = 128; // fixed, room for any count

	public static byte[] Header<T>(long count) where T : unmanaged
	{
		var descr = typeof(T) == typeof(float) ? "<f4" : typeof(T) == typeof(double) ? "<f8" : typeof(T) == typeof(int) ? "<i4" : typeof(T) == typeof(long) ? "<i8" : typeof(T) == typeof(short) ? "<i2" : throw new NotSupportedException(typeof(T).Name);
		var text = $"{{'descr': '{descr}', 'fortran_order': False, 'shape': ({count},), }}";
		var header = new byte[HeaderLength];
		header.AsSpan().Fill((byte)' ');
		new byte[] { 0x93, (byte)'N', (byte)'U', (byte)'M', (byte)'P', (byte)'Y', 1, 0 }.CopyTo(header, 0);
		BitConverter.GetBytes((ushort)(HeaderLength - 10)).CopyTo(header, 8);
		Encoding.ASCII.GetBytes(text).CopyTo(header, 10);
		header[HeaderLength - 1] = (byte)'\n';
		return header;
	}

	/// <summary>Like <see cref="Repair{T}"/>, for a file of any of the supported number types (read from its header).</summary>
	public static void RepairAny(string path)
	{
		string text;
		using (var stream = File.OpenRead(path))
		{
			var head = new byte[HeaderLength];
			if (stream.Read(head) < HeaderLength) return;
			text = Encoding.ASCII.GetString(head, 10, HeaderLength - 10);
		}
		if (text.Contains("'<f4'")) Repair<float>(path);
		else if (text.Contains("'<f8'")) Repair<double>(path);
		else if (text.Contains("'<i4'")) Repair<int>(path);
		else if (text.Contains("'<i8'")) Repair<long>(path);
		else if (text.Contains("'<i2'")) Repair<short>(path);
	}

	/// <summary>Fixes the length in the header of a file whose writer never got to finish it (from the size of the file).</summary>
	public static void Repair<T>(string path) where T : unmanaged
	{
		using var stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite);
		if (stream.Length < HeaderLength) return;
		var count = (stream.Length - HeaderLength) / System.Runtime.CompilerServices.Unsafe.SizeOf<T>();
		stream.SetLength(HeaderLength + count * System.Runtime.CompilerServices.Unsafe.SizeOf<T>()); // drop a half-written value
		stream.Seek(0, SeekOrigin.Begin);
		stream.Write(Header<T>(count));
	}
}
