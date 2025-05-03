using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class NPYStreamWriter<T> : IDisposable where T : unmanaged
{
	private readonly int TotalHeaderLength;
	public readonly Stream BaseStream;
	private bool CloseUnderlyingStream;

	public NPYStreamWriter(Stream stream, bool closeUnderlyingStream = true)
	{
		BaseStream = stream;
		CloseUnderlyingStream = closeUnderlyingStream;

		var MAGIC_STRING = new byte[] { 0x93, 0x4E, 0x55, 0x4D, 0x50, 0x59, 0x01, 0x00 }; // "\x93NUMPY\x01\x00"
		var dataType = typeof(T);
		var HEADER_1 = "{'descr': '<"u8;
		var type = dataType.Name switch
		{
			"Single" => "f4"u8,
			"Double" => "f8"u8,
			"Int32" => "i4"u8,
			"Int64" => "i8"u8,
			_ => throw new NotImplementedException(),
		};
		var HEADER_2 = "', 'fortran_order': False, 'shape': (            0,), }\n"u8; // sufficient space for final shape
		var headerLength = HEADER_1.Length + type.Length + HEADER_2.Length;
		TotalHeaderLength = MAGIC_STRING.Length + 2 + headerLength;
		Debug.Assert(TotalHeaderLength % 16 == 0);
		stream.Write(MAGIC_STRING);
		stream.Write(BitConverter.GetBytes((ushort)headerLength));
		stream.Write(HEADER_1);
		stream.Write(type);
		stream.Write(HEADER_2);
	}

	public NPYStreamWriter(string path) : this(File.OpenWrite(path)) { }

	private bool IsDisposed = false;
	public void Dispose()
	{
		if(IsDisposed) return;
		IsDisposed = true;
		var length = BaseStream.Length - TotalHeaderLength;
		var itemCount = length / Marshal.SizeOf<T>();

		BaseStream.Seek(TotalHeaderLength - 17, SeekOrigin.Begin);
		var itemCountString = itemCount.ToString().PadLeft(11);
		var itemCountBytes = Encoding.ASCII.GetBytes(itemCountString);
		BaseStream.Write(itemCountBytes);

		if (CloseUnderlyingStream)
		{
			BaseStream.Dispose();
		}
	}

	public void WriteArray(T[] array)
	{
		if(IsDisposed) throw new Exception("Can't write to an already disposed NPYStreamWriter");
		BaseStream.Write(MemoryMarshal.AsBytes(new ReadOnlySpan<T>(array)));
	}
	public void WriteArray(ReadOnlySpan<T> array)
	{
		if(IsDisposed) throw new Exception("Can't write to an already disposed NPYStreamWriter");
		BaseStream.Write(MemoryMarshal.AsBytes(array));
	}
}
