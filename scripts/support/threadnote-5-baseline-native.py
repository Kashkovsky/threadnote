"""Native evidence image boundary, loaded into argv for an isolated OS interpreter."""
import ctypes as c
import fcntl
import hashlib
import os
import signal
import stat
import sys
import tempfile

MAX_IMAGE = 512 * 1024 * 1024


def interrupted(_signal, _frame):
    raise ValueError('native execution interrupted')


def version(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_ctime_ns, info.st_mtime_ns,
            getattr(info, 'st_flags', 0))


def read_image(fd, expected, destination=None):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_IMAGE:
        raise ValueError('invalid native image size or type')
    magic = os.pread(fd, 4, 0)
    native_magic = (b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca')
    if magic not in (native_magic if sys.platform == 'darwin' else (b'\x7fELF',)):
        raise ValueError('baseline, observer, and judge must be native executable images; scripts are unsupported')
    digest = hashlib.sha256()
    position = 0
    while position < before.st_size:
        chunk = os.pread(fd, min(65536, before.st_size - position), position)
        if not chunk:
            raise ValueError('native image ended early')
        digest.update(chunk)
        if destination is not None:
            written = 0
            while written < len(chunk):
                step = os.pwrite(destination, chunk[written:], position + written)
                if step <= 0:
                    raise ValueError('native image copy made no progress')
                written += step
        position += len(chunk)
    if version(before) != version(os.fstat(fd)) or digest.hexdigest() != expected:
        raise ValueError('native image changed after parent verification')


class Region(c.Structure):
    _fields_ = [('protection', c.c_uint32), ('max_protection', c.c_uint32), ('inheritance', c.c_uint32),
                ('flags', c.c_uint32), ('offset', c.c_uint64), ('counters', c.c_uint32 * 14),
                ('address', c.c_uint64), ('size', c.c_uint64)]


class Vstat(c.Structure):
    _fields_ = [('dev', c.c_uint32), ('mode', c.c_uint16), ('nlink', c.c_uint16), ('ino', c.c_uint64),
                ('uid', c.c_uint32), ('gid', c.c_uint32), ('times', c.c_int64 * 8), ('size', c.c_int64),
                ('blocks', c.c_int64), ('blksize', c.c_int32), ('flags', c.c_uint32), ('gen', c.c_uint32),
                ('rdev', c.c_uint32), ('spare', c.c_int64 * 2)]


class RegionPath(c.Structure):
    _fields_ = [('region', Region), ('vstat', Vstat), ('type', c.c_int), ('pad', c.c_int),
                ('fsid', c.c_int32 * 2), ('path', c.c_char * 1024)]


def mapped_image(lib, pid, expected):
    address = 0
    lib.proc_pidinfo.argtypes = [c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int]
    for _ in range(4096):
        info = RegionPath()
        if lib.proc_pidinfo(pid, 8, address, c.byref(info), c.sizeof(info)) != c.sizeof(info):
            return False
        if info.region.protection & 4:
            return (info.vstat.dev, info.vstat.ino, info.vstat.size) == (expected.st_dev, expected.st_ino, expected.st_size)
        following = info.region.address + info.region.size
        if following <= address:
            return False
        address = following
    return False


def arguments(path, values):
    argv = (c.c_char_p * (len(values) + 2))(os.fsencode(path), *[os.fsencode(a) for a in values], None)
    env = (c.c_char_p * (len(os.environ) + 1))(*[os.fsencode(k + '=' + v) for k, v in os.environ.items()], None)
    return argv, env


def execute_darwin(expected, target, values):
    lib = c.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    lib.fchflags.argtypes = [c.c_int, c.c_uint]
    writable, path = tempfile.mkstemp(prefix='threadnote-image-')
    image = -1
    pid = c.c_int()
    try:
        read_image(3, expected, writable)
        os.fsync(writable)
        os.fchmod(writable, 0o500)
        image = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        if os.fstat(image).st_ino != os.fstat(writable).st_ino:
            raise ValueError('private native image was retargeted')
        os.close(writable)
        writable = -1
        if lib.fchflags(image, stat.UF_IMMUTABLE):
            raise ValueError('could not make native image immutable')
        before = os.fstat(image)
        read_image(image, expected)
        attr = c.c_void_p()
        if lib.posix_spawnattr_init(c.byref(attr)) or lib.posix_spawnattr_setflags(c.byref(attr), 0x80):
            raise ValueError('suspended spawn setup failed')
        argv, env = arguments(target, values)
        try:
            error = lib.posix_spawn(c.byref(pid), os.fsencode(path), None, c.byref(attr), argv, env)
        finally:
            lib.posix_spawnattr_destroy(c.byref(attr))
        if error:
            raise ValueError('suspended native spawn failed')
        if not mapped_image(lib, pid.value, before) or version(before) != version(os.fstat(image)):
            raise ValueError('suspended image does not match the pinned private inode')
        final = version(os.fstat(image))
        read_image(image, expected)
        if final != version(os.fstat(image)):
            raise ValueError('native image changed before resume')
        os.kill(pid.value, signal.SIGCONT)
        _, status = os.waitpid(pid.value, 0)
        pid.value = 0
        if final != version(os.fstat(image)):
            raise ValueError('native image changed while running')
        return os.waitstatus_to_exitcode(status)
    finally:
        if pid.value > 0:
            try:
                os.kill(pid.value, signal.SIGKILL)
                os.waitpid(pid.value, 0)
            except ProcessLookupError:
                pass
        if writable >= 0:
            os.close(writable)
        if image >= 0:
            if lib.fchflags(image, 0):
                raise ValueError('could not release native image immutability')
            os.close(image)
        if path is not None:
            os.unlink(path)


def execute_linux(expected, target, values):
    image = os.memfd_create('threadnote-evidence-image', os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    try:
        read_image(3, expected, image)
        os.fchmod(image, 0o500)
        fcntl.fcntl(image, fcntl.F_ADD_SEALS,
                    fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
        read_image(image, expected)
        argv, env = arguments(target, values)
        lib = c.CDLL(None, use_errno=True)
        lib.fexecve.argtypes = [c.c_int, c.POINTER(c.c_char_p), c.POINTER(c.c_char_p)]
        lib.fexecve(image, argv, env)
        raise ValueError('sealed descriptor execution failed')
    finally:
        os.close(image)


try:
    signal.signal(signal.SIGTERM, interrupted)
    if sys.platform == 'darwin':
        sys.exit(execute_darwin(sys.argv[1], sys.argv[2], sys.argv[3:]))
    elif sys.platform == 'linux':
        execute_linux(sys.argv[1], sys.argv[2], sys.argv[3:])
    else:
        raise ValueError('native evidence execution requires macOS or Linux')
except (OSError, ValueError) as error:
    print('Baseline native boundary: ' + (str(error) if isinstance(error, ValueError) else 'OS operation failed'), file=sys.stderr)
    sys.exit(125)
