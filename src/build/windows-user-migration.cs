using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace AnubisInstaller {
  public static class UserMigration {
    [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
    [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr memory);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr ILCreateFromPath(string path);
    [DllImport("shell32.dll")] static extern uint ILGetSize(IntPtr list);
    [DllImport("shell32.dll")] static extern void ILFree(IntPtr list);
    static string Folder(string value) {
      Guid id = new Guid(value); IntPtr memory;
      int error = SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out memory);
      try { Marshal.ThrowExceptionForHR(error); return Marshal.PtrToStringUni(memory); }
      finally { if (memory != IntPtr.Zero) CoTaskMemFree(memory); }
    }
    public static string UserPrograms() { return Folder("5CD7AEE2-2219-4A67-B85D-6C9CE15660CB"); }
    public static string Desktop() { return Folder("B4BFCC3A-DB2C-424C-B029-7FE99A87C641"); }
    public static string Programs() { return Folder("A77F5D77-2E2B-44C3-A6A2-ABA601054A51"); }
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr data, out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, byte[] info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint size, uint flags);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint info, out IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern int RegOpenKeyEx(SafeRegistryHandle parent, string name, uint options, int access, out SafeRegistryHandle result);
    [DllImport("ntdll.dll")] static extern int NtDeleteKey(SafeRegistryHandle key);
    [StructLayout(LayoutKind.Sequential)]
    struct FileInfo {
      public uint Attributes;
      public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
      public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    static string SessionValue(int session, int info) {
      IntPtr data; int bytes;
      if (!WTSQuerySessionInformation(IntPtr.Zero, session, info, out data, out bytes))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      try { return Marshal.PtrToStringUni(data); } finally { WTSFreeMemory(data); }
    }
    public static string InteractiveSid() {
      int session = System.Diagnostics.Process.GetCurrentProcess().SessionId;
      if (session == 0) throw new InvalidOperationException("Migration requires an interactive same-account administrator");
      string user = SessionValue(session, 5), domain = SessionValue(session, 7);
      if (String.IsNullOrEmpty(user)) throw new InvalidOperationException("No interactive Windows user");
      return new NTAccount(domain, user).Translate(typeof(SecurityIdentifier)).Value;
    }
    public static RegistryKey OpenUserKey(string path, bool writable) {
      const string classes = @"Software\Classes\";
      bool userClasses = path.StartsWith(classes, StringComparison.OrdinalIgnoreCase);
      RegistryKey current = RegistryKey.OpenBaseKey(userClasses ? RegistryHive.Users : RegistryHive.CurrentUser, RegistryView.Registry64);
      if (userClasses) path = WindowsIdentity.GetCurrent().User.Value + @"_Classes\" + path.Substring(classes.Length);
      try {
        foreach (string part in path.Split('\\')) {
          if (part.Length == 0) throw new InvalidOperationException("Empty registry path component");
          SafeRegistryHandle handle;
          int error = RegOpenKeyEx(current.Handle, part, 8, writable ? 0x3001f : 0x20019, out handle);
          if (error == 2) { handle.Dispose(); return null; }
          if (error != 0) { handle.Dispose(); throw new Win32Exception(error); }
          RegistryKey next = RegistryKey.FromHandle(handle, RegistryView.Registry64);
          try {
            foreach (string name in next.GetValueNames())
              if (name.Equals("SymbolicLinkValue", StringComparison.OrdinalIgnoreCase) || (int)next.GetValueKind(name) == 6)
                throw new InvalidOperationException("Registry links are forbidden");
          } catch { next.Dispose(); throw; }
          current.Dispose();
          current = next;
        }
        RegistryKey result = current;
        current = null;
        return result;
      } finally { if (current != null) current.Dispose(); }
    }
    public static void DeleteKey(RegistryKey key) {
      if (key.SubKeyCount != 0) throw new InvalidOperationException("Unknown legacy registry children");
      int status = NtDeleteKey(key.Handle);
      if (status != 0) throw new InvalidOperationException("Cannot remove validated legacy registration: NTSTATUS " + status);
    }

    public sealed class PinnedPath : IDisposable {
      readonly List<SafeFileHandle> parents = new List<SafeFileHandle>();
      FileStream stream;
      public byte[] Bytes { get { if (stream.Length > 131072) throw new InvalidDataException("Shortcut too large"); stream.Position = 0; byte[] bytes = new byte[stream.Length]; int read = 0; while (read < bytes.Length) { int n = stream.Read(bytes, read, bytes.Length - read); if (n == 0) throw new EndOfStreamException(); read += n; } return bytes; } }
      public PinnedPath(string path, bool directory, bool writable, string owner) {
        try {
          if (!Path.IsPathRooted(path) || path.StartsWith(@"\\") || !Path.GetFullPath(path).Equals(path, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Migration paths must be canonical local paths");
          string root = Path.GetPathRoot(path), cursor = root;
          string[] parts = path.Substring(root.Length).Split(new char[] {'\\'}, StringSplitOptions.RemoveEmptyEntries);
          for (int i = -1; i < parts.Length; i++) {
            if (i >= 0) cursor = Path.Combine(cursor, parts[i]);
            bool last = i == parts.Length - 1;
            uint access = 0x20080;
            if (last && !directory) access |= writable ? 0xc0010000u : 0x80000000u;
            SafeFileHandle handle = CreateFile(cursor, access, last && !directory ? 1u : 3u, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
            parents.Add(handle);
            FileInfo info;
            if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((info.Attributes & 0x400) != 0) throw new InvalidOperationException("Migration reparse points are forbidden");
            bool isDirectory = (info.Attributes & 0x10) != 0;
            if (isDirectory != (!last || directory)) throw new InvalidOperationException("Unexpected migration path type");
            var finalPath = new StringBuilder(32768);
            uint count = GetFinalPathNameByHandle(handle, finalPath, (uint)finalPath.Capacity, 0);
            if (count == 0 || count >= finalPath.Capacity || !finalPath.ToString().Equals(@"\\?\" + cursor.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) &&
                !finalPath.ToString().Equals(@"\\?\" + cursor, StringComparison.OrdinalIgnoreCase))
              throw new InvalidOperationException("Migration path resolved elsewhere");
            if (last) {
              IntPtr sid, descriptor;
              uint error = GetSecurityInfo(handle, 1, 1, out sid, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor);
              if (error != 0) throw new Win32Exception((int)error);
              try {
                string actual = new SecurityIdentifier(sid).Value;
                if (owner != null && actual != owner && actual != "S-1-5-18" && actual != "S-1-5-32-544")
                  throw new InvalidOperationException("Foreign migration file owner");
              }
              finally { LocalFree(descriptor); }
              if (!directory) {
                if (info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > 131072 && writable)
                  throw new InvalidOperationException("Migration files must not be hard-linked; shortcuts are bounded");
                if (writable && info.SizeLow > 131072) throw new InvalidOperationException("Shortcut too large");
                stream = new FileStream(handle, writable ? FileAccess.ReadWrite : FileAccess.Read);
              }
            }
          }
        } catch { Dispose(); throw; }
      }
      public void Write(byte[] bytes) {
        stream.Position = 0;
        stream.Write(bytes, 0, bytes.Length);
        stream.SetLength(bytes.Length);
        stream.Flush(true);
      }
      public void Delete() {
        if (!SetFileInformationByHandle(stream.SafeFileHandle, 4, new byte[] {1}, 1))
          throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      public void Dispose() {
        if (stream != null) { stream.Dispose(); stream = null; }
        foreach (SafeFileHandle handle in parents) handle.Dispose();
        parents.Clear();
      }
    }
    static readonly byte[] ClassId = {1,20,2,0,0,0,0,0,192,0,0,0,0,0,0,70};
    static uint U32(byte[] bytes, int offset) {
      if (offset < 0 || offset > bytes.Length - 4) throw new InvalidDataException("Truncated shortcut");
      return BitConverter.ToUInt32(bytes, offset);
    }
    static string Text(byte[] bytes, int start, int end, bool unicode) {
      int step = unicode ? 2 : 1, cursor = start;
      if (start < 0 || start >= end || end > bytes.Length) throw new InvalidDataException("Invalid shortcut string");
      while (cursor <= end - step) {
        if (bytes[cursor] == 0 && (!unicode || bytes[cursor + 1] == 0))
          return (unicode ? Encoding.Unicode : Encoding.Default).GetString(bytes, start, cursor - start);
        cursor += step;
      }
      throw new InvalidDataException("Unterminated shortcut string");
    }
    public static string ShortcutTarget(byte[] bytes) {
      if (bytes.Length < 80 || bytes.Length > 131072 || U32(bytes, 0) != 76) throw new InvalidDataException("Invalid shortcut header");
      for (int i = 0; i < ClassId.Length; i++) if (bytes[4 + i] != ClassId[i]) throw new InvalidDataException("Invalid shortcut class");
      uint flags = U32(bytes, 20);
      // Icon-environment metadata is discarded, never resolved or copied.
      if ((flags & 2) == 0 || (flags & ~0x40ffu) != 0) throw new InvalidDataException("Unsupported shortcut target flags");
      int offset = 76;
      if ((flags & 1) != 0) { if (offset + 2 > bytes.Length) throw new InvalidDataException(); offset += 2 + BitConverter.ToUInt16(bytes, offset); }
      uint size = U32(bytes, offset), header = U32(bytes, offset + 4);
      if (size > bytes.Length - offset || header < 28 || header > size || U32(bytes, offset + 8) != 1)
        throw new InvalidDataException("Unsupported shortcut link information");
      bool unicode = header >= 36 && U32(bytes, offset + 28) != 0;
      uint local = U32(bytes, offset + (unicode ? 28 : 16));
      if (local < header || local >= size) throw new InvalidDataException("Invalid shortcut target");
      string target = Text(bytes, checked(offset + (int)local), checked(offset + (int)size), unicode);
      int cursor = checked(offset + (int)size);
      for (uint field = 4; field <= 64; field <<= 1) {
        if ((flags & field) == 0) continue;
        if (cursor > bytes.Length - 2) throw new InvalidDataException("Truncated shortcut string data");
        int characters = BitConverter.ToUInt16(bytes, cursor);
        cursor += 2;
        int length = characters * ((flags & 128) != 0 ? 2 : 1);
        if (length > bytes.Length - cursor) throw new InvalidDataException("Truncated shortcut string data");
        if (field == 32 && characters != 0) throw new InvalidDataException("Shortcut arguments are forbidden");
        cursor += length;
      }
      return target;
    }
    public static byte[] Shortcut(string target) {
      if (!Path.IsPathRooted(target) || target.IndexOf('\0') >= 0) throw new InvalidDataException("Invalid shortcut target");
      byte[] ansi = Encoding.Default.GetBytes(target + "\0"), unicode = Encoding.Unicode.GetBytes(target + "\0");
      IntPtr nativeId = ILCreateFromPath(target);
      if (nativeId == IntPtr.Zero) throw new InvalidDataException("Cannot create protected target identifier");
      byte[] id;
      try { id = new byte[checked((ushort)ILGetSize(nativeId))]; Marshal.Copy(nativeId, id, 0, id.Length); }
      finally { ILFree(nativeId); }
      using (var data = new MemoryStream())
      using (var writer = new BinaryWriter(data)) {
        writer.Write(76); writer.Write(ClassId); writer.Write(0x8b); writer.Write(new byte[36]); writer.Write(1); writer.Write(new byte[12]);
        writer.Write(checked((ushort)id.Length)); writer.Write(id);
        int local = 53, suffix = local + ansi.Length, localUnicode = suffix + 1, suffixUnicode = localUnicode + unicode.Length;
        writer.Write(suffixUnicode + 2); writer.Write(36); writer.Write(1); writer.Write(36); writer.Write(local); writer.Write(0); writer.Write(suffix); writer.Write(localUnicode); writer.Write(suffixUnicode);
        writer.Write(17); writer.Write(3); writer.Write(0); writer.Write(16); writer.Write((byte)0);
        writer.Write(ansi); writer.Write((byte)0); writer.Write(unicode); writer.Write((ushort)0);
        writer.Write(checked((ushort)target.Length)); writer.Write(Encoding.Unicode.GetBytes(target)); writer.Write(0);
        return data.ToArray();
      }
    }
  }
}
