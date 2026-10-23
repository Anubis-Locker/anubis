#!/bin/sh
set -eu
base=/opt/anubis-qa-spice
case "${1:-}" in
stop)
  python3 - <<'PY'
import pathlib, os, signal, time, shutil
base = pathlib.Path("/opt/anubis-qa-spice")
pidfile = base / "qemu.pid"
if pidfile.exists():
    pid = int(pidfile.read_text())
    proc = pathlib.Path(f"/proc/{pid}/cmdline")
    if proc.exists():
        command = proc.read_bytes()
        if b"qemu-system-x86_64" not in command or os.readlink(f"/proc/{pid}/cwd") != str(base):
            raise RuntimeError("Spice fixture PID ownership changed")
        os.kill(pid, signal.SIGTERM)
        for attempt in range(50):
            if not proc.exists() or not proc.read_bytes(): break
            time.sleep(.1)
        else:
            raise RuntimeError("Spice fixture did not exit")
if base.exists():
    shutil.rmtree(base)
PY
  exit 0
  ;;
start) ;;
*) echo 'Usage: spice-test-guest.sh start|stop' >&2; exit 2 ;;
esac
test ! -e "$base"
if ss -ltn | grep -Eq '127.0.0.1:5999 '; then
  echo 'Spice fixture port is occupied' >&2
  exit 1
fi
mkdir -m 755 "$base"
cat >"$base/boot.S" <<'ASM'
.intel_syntax noprefix
.code16
.global _start
_start:
  cli
  xor ax, ax
  mov ds, ax
  mov es, ax
  mov ss, ax
  mov sp, 0x7c00
  sti
  mov ax, 3
  int 0x10
  mov si, offset banner
print:
  lodsb
  test al, al
  jz keyboard
  mov ah, 0x0e
  mov bx, 7
  int 0x10
  out 0xe9, al
  jmp print
keyboard:
  xor ah, ah
  int 0x16
  out 0xe9, al
  mov ah, 0x0e
  mov bx, 7
  int 0x10
  jmp keyboard
banner:
  .asciz "ANUBIS SPICE QA READY\r\n"
  .org 510
  .word 0xaa55
ASM
as --32 -o "$base/boot.o" "$base/boot.S"
ld -m elf_i386 -Ttext 0x7c00 --oformat=binary -o "$base/boot.img" "$base/boot.o"
chown -R anubis-svc:anubis-svc "$base"
runuser -u anubis-svc -- sh -c '
  cd /opt/anubis-qa-spice
  setsid qemu-system-x86_64 -machine pc,accel=tcg -m 64 -no-reboot \
    -drive file=boot.img,format=raw,if=floppy,readonly=on -boot a \
    -vga qxl -display none -spice addr=127.0.0.1,port=5999,disable-ticketing=on \
    -debugcon file:guest-input.log -trace enable=input_event_*,file=input-trace.log \
    -monitor none -serial none >qemu.log 2>&1 </dev/null &
  echo $! >qemu.pid
'
for attempt in $(seq 1 50); do
  if grep -q 'ANUBIS SPICE QA READY' "$base/guest-input.log" 2>/dev/null; then
    echo 'Owned loopback-only Spice guest is ready'
    exit 0
  fi
  sleep .1
done
cat "$base/qemu.log" >&2
exit 1
