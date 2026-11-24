using System.Runtime.InteropServices;

namespace LabOrchestra.Plugins.Oscilloscope;

/// <summary>A ring of floats in native memory for one writer thread and one reader thread (no locks). Native, so that the garbage
/// collector never sees hundreds of megabytes, and aligned, so that an FFT may read from it directly.</summary>
public sealed unsafe class NativeRing : IDisposable
{
	private readonly float* _data;
	private readonly long _mask;
	private long _write, _read;
	private volatile bool _reset;

	public NativeRing(int capacity)
	{
		if (capacity < 2 || (capacity & (capacity - 1)) != 0) throw new ArgumentException("The capacity must be a power of two");
		Capacity = capacity;
		_mask = capacity - 1;
		_data = (float*)NativeMemory.AlignedAlloc((nuint)capacity * sizeof(float), 64);
	}

	public int Capacity { get; }

	public long Available
	{
		get
		{
			if (_reset) DiscardBacklog();
			return Volatile.Read(ref _write) - Volatile.Read(ref _read);
		}
	}

	/// <summary>Adds samples; false if they do not fit (nothing is written then).</summary>
	public bool Write(ReadOnlySpan<float> source)
	{
		var write = Volatile.Read(ref _write);
		if (write + source.Length - Volatile.Read(ref _read) > Capacity) return false;
		var start = (int)(write & _mask);
		var first = Math.Min(source.Length, Capacity - start);
		source[..first].CopyTo(new Span<float>(_data + start, first));
		source[first..].CopyTo(new Span<float>(_data, source.Length - first));
		Volatile.Write(ref _write, write + source.Length);
		return true;
	}

	/// <summary>Removes up to <c>destination.Length</c> samples (oldest first); returns how many.</summary>
	public int Read(Span<float> destination)
	{
		var count = (int)Math.Min(Available, destination.Length);
		var read = Volatile.Read(ref _read);
		var start = (int)(read & _mask);
		var first = Math.Min(count, Capacity - start);
		new Span<float>(_data + start, first).CopyTo(destination);
		new Span<float>(_data, count - first).CopyTo(destination[first..]);
		Volatile.Write(ref _read, read + count);
		return count;
	}

	/// <summary>Reads <c>window.Length</c> samples multiplied by the window straight into <paramref name="destination"/> (no intermediate copy;
	/// the wrap-around makes two segments). Requires that many samples to be available.</summary>
	public void ReadWindowed(Span<float> destination, ReadOnlySpan<float> window)
	{
		var count = window.Length;
		if (Available < count) throw new InvalidOperationException("Not enough samples in the ring");
		var read = Volatile.Read(ref _read);
		var start = (int)(read & _mask);
		var first = Math.Min(count, Capacity - start);
		Multiply(new ReadOnlySpan<float>(_data + start, first), window[..first], destination[..first]);
		Multiply(new ReadOnlySpan<float>(_data, count - first), window[first..count], destination[first..count]);
		Volatile.Write(ref _read, read + count);
	}

	private static void Multiply(ReadOnlySpan<float> a, ReadOnlySpan<float> b, Span<float> result)
	{
		var i = 0;
		if (System.Numerics.Vector.IsHardwareAccelerated)
			for (; i <= a.Length - System.Numerics.Vector<float>.Count; i += System.Numerics.Vector<float>.Count)
				(new System.Numerics.Vector<float>(a[i..]) * new System.Numerics.Vector<float>(b[i..])).CopyTo(result[i..]);
		for (; i < a.Length; i++) result[i] = a[i] * b[i];
	}

	/// <summary>The reader drops what has piled up and goes on with what comes next (asked for by the writer when it overran).</summary>
	public void RequestReset() => _reset = true;

	public void Clear() => _reset = true;

	private void DiscardBacklog()
	{
		_reset = false;
		Volatile.Write(ref _read, Volatile.Read(ref _write));
	}

	public void Dispose() => NativeMemory.AlignedFree(_data);
}
