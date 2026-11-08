"""Bounded Git relay for Soreno's Windows -> WSL display reads and branch switches.

The relay owns no Git data cache.  Each accepted frame executes one literal argv.
A Linux supervisor is started before every Git process and watches a life pipe:
if this relay dies, it kills the whole Git process group. PR_SET_PDEATHSIG and a
pre-exec group handshake close the parent-death race.
"""

import base64
import binascii
import ctypes
import io
import json
import os
import selectors
import signal
import struct
import subprocess
import sys
import time

VERSION = 1
STDIN_LIMIT = 8 * 1024 * 1024
STDOUT_LIMIT = 8 * 1024 * 1024
STDERR_LIMIT = 256 * 1024
REQUEST_FRAME_LIMIT = 12 * 1024 * 1024
RESPONSE_FRAME_LIMIT = 12 * 1024 * 1024
CHUNK = 64 * 1024
MAX_TIMEOUT_MS = 120_000
_SUBREAPER_ENABLED = False

_FIXED_PREFIX = [
    "--no-replace-objects",
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "color.ui=false",
    "-c",
    "core.pager=cat",
    "-c",
    "diff.external=",
    "-C",
]
_SAFETY_ARGS = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.pager=cat",
    "-c",
    "pager.status=false",
    "-c",
    "pager.log=false",
    "-c",
    "pager.diff=false",
    "-c",
    "log.showSignature=false",
    "-c",
    "diff.external=",
]


class _PreflightCaptureError(Exception):
    def __init__(self, result):
        self.result = result


def _is_text_list(value):
    return (
        isinstance(value, list)
        and len(value) <= 128
        and all(isinstance(item, str) and len(item) <= 16384 and "\0" not in item for item in value)
    )


def _split_args(args_git):
    if not _is_text_list(args_git) or len(args_git) < len(_FIXED_PREFIX) + 2:
        return None
    if args_git[: len(_FIXED_PREFIX)] != _FIXED_PREFIX:
        return None
    path = args_git[len(_FIXED_PREFIX)]
    if not path or len(path) > 32768 or "\0" in path:
        return None
    return path, args_git[len(_FIXED_PREFIX) + 1 :]


def _oidish(value):
    return bool(value) and len(value) <= 4096 and not value.startswith("-") and "\0" not in value


def _refname(value):
    return _oidish(value) and all(ord(character) > 32 and ord(character) != 127 and not character.isspace() for character in value)


def _is_switch_command(command):
    return (
        len(command) == 4
        and command[:3] == ["switch", "--no-overwrite-ignore", "--no-guess"]
        and _refname(command[3])
    ) or (
        len(command) == 6
        and command[:4] == ["switch", "--no-overwrite-ignore", "--track", "-c"]
        and _refname(command[4])
        and command[5].startswith("refs/remotes/")
        and _refname(command[5][len("refs/remotes/") :])
    )


def _full_oid(value):
    return len(value) in (40, 64) and all(character in "0123456789abcdef" for character in value)


def _is_range_diff(command):
    # Revisions must be literal OIDs: `R^@` on a root commit expands to nothing and diffs the worktree.
    return (
        len(command) == 12
        and command[:9] == ["diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--raw", "--numstat", "-z", "--no-abbrev", "-M"]
        and _full_oid(command[9])
        and _full_oid(command[10])
        and command[11] == "--"
    )


def _allowed_command(command):
    """Accept only the exact read shapes used by display helpers."""
    if command == ["--version"]:
        return True
    if not command:
        return False
    name, rest = command[0], command[1:]

    if name == "rev-parse":
        fixed = {
            ("--short", "HEAD"),
            ("--is-bare-repository",),
            ("--absolute-git-dir",),
            ("--path-format=absolute", "--git-common-dir"),
            ("--path-format=absolute", "--show-toplevel"),
            ("--show-object-format=storage",),
            (
                "--path-format=absolute",
                "--is-bare-repository",
                "--absolute-git-dir",
                "--git-common-dir",
                "--show-toplevel",
                "--show-object-format=storage",
            ),
        }
        if tuple(rest) in fixed:
            return True
        if rest[:2] == ["--verify", "-q"]:
            return len(rest) == 3 and _oidish(rest[2])
        if rest[:2] == ["--verify", "--quiet"]:
            return len(rest) == 3 and _oidish(rest[2]) and rest[2].endswith("^{commit}")
        if rest[:1] == ["--verify"]:
            return len(rest) == 2 and _oidish(rest[1])
        return bool(rest) and len(rest) <= 2 and all(_oidish(value) for value in rest)

    if name == "symbolic-ref":
        return rest == ["--quiet", "--short", "HEAD"]

    if name == "merge-base":
        return len(rest) == 2 and all(_oidish(value) for value in rest)

    if name == "switch":
        return _is_switch_command(command)

    if name == "status":
        return rest in (
            ["--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
            ["--porcelain=v2", "-z", "--untracked-files=all"],
        )

    if name == "diff":
        if _is_range_diff(command):
            return True
        if rest[:2] != ["--no-ext-diff", "--no-textconv"]:
            return False
        return rest[2:] in (
            ["--numstat", "-z", "--"],
            ["--cached", "--numstat", "-z", "--"],
        )

    if name == "ls-files":
        return rest == ["--stage", "-z"]

    if name == "ls-tree":
        return (
            len(rest) == 4
            and rest[0] == "-z"
            and _oidish(rest[1])
            and rest[2] == "--"
            and bool(rest[3])
        )

    if name == "cat-file":
        return rest in (["--batch-check"], ["--batch"]) or (
            len(rest) == 2 and rest[0] in ("-s", "blob") and _oidish(rest[1])
        )

    if name == "hash-object":
        return rest == ["--no-filters", "--stdin-paths"]

    if name == "log":
        history_page = (
            len(rest) == 10
            and rest[:3] == ["--no-ext-diff", "--no-textconv", "--no-show-signature"]
            and rest[3:5] == ["-z", "--format=%H%x00%an%x00%cI%x00%s"]
            and rest[5] == "--max-count"
            and rest[6].isdigit()
            and rest[7] == "--skip"
            and rest[8].isdigit()
            and _oidish(rest[9])
        )
        commit_archive = (
            len(rest) == 15
            and rest[:13] == [
                "--no-ext-diff",
                "--no-textconv",
                "--no-show-signature",
                "--no-relative",
                "-1",
                "--format=%H%x00%P",
                "--root",
                "--diff-merges=first-parent",
                "--raw",
                "--numstat",
                "-z",
                "--no-abbrev",
                "-M",
            ]
            and _oidish(rest[13])
            and rest[14] == "--"
        )
        return history_page or commit_archive

    if name == "for-each-ref":
        return rest == [
            "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(symref)",
            "refs/heads",
            "refs/remotes",
        ]

    if name == "remote":
        if not rest:
            return True
        options = rest[1:-1]
        return (
            len(rest) in (3, 4)
            and rest[0] == "get-url"
            and options in (["--all"], ["--push", "--all"])
            and _oidish(rest[-1])
        )

    return False


def validate_args(args_git):
    split = _split_args(args_git)
    return split is not None and _allowed_command(split[1])


def _valid_batch_input(input_data):
    if not input_data or not input_data.endswith(b"\n"):
        return False
    oids = input_data[:-1].split(b"\n")
    return 1 <= len(oids) <= 2 and all(
        len(oid) in (40, 64) and all(byte in b"0123456789abcdefABCDEF" for byte in oid)
        for oid in oids
    )


def _prepare_child(group_write):
    os.setsid()
    # Linux prctl(2) closes the parent-death race before exec.  The independent
    # life-pipe supervisor below owns termination of the entire process group.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() == 1:
        os._exit(127)
    try:
        os.write(group_write, struct.pack(">Q", os.getpid()))
    except OSError:
        os._exit(127)
    os.close(group_write)


def _supervise(life_read, group_read):
    try:
        encoded = _read_fd_exact(group_read, 8)
        if encoded is None:
            return
        process_group = struct.unpack(">Q", encoded)[0]
        while True:
            data = os.read(life_read, 1)
            if data == b"D":
                return
            if not data:
                try:
                    os.killpg(process_group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                return
    finally:
        os.close(life_read)
        os.close(group_read)


def _read_fd_exact(descriptor, size):
    data = bytearray()
    while len(data) < size:
        try:
            chunk = os.read(descriptor, size - len(data))
        except InterruptedError:
            continue
        if not chunk:
            return None
        data.extend(chunk)
    return bytes(data)


def _start_supervisor():
    global _SUBREAPER_ENABLED
    if not _SUBREAPER_ENABLED:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_CHILD_SUBREAPER)")
        _SUBREAPER_ENABLED = True
    life_read, life_write = os.pipe()
    group_read, group_write = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(life_write)
        os.close(group_write)
        _supervise(life_read, group_read)
        os._exit(0)
    os.close(life_read)
    os.close(group_read)
    return life_write, group_write, pid


def _finish_supervisor(life_write, supervisor_pid, group_gone):
    if group_gone:
        try:
            os.write(life_write, b"D")
        except OSError:
            pass
    try:
        os.close(life_write)
    except OSError:
        pass
    try:
        os.waitpid(supervisor_pid, 0)
    except ChildProcessError:
        pass


def _reap_group(process_group):
    while True:
        try:
            pid, _ = os.waitpid(-process_group, os.WNOHANG)
        except ChildProcessError:
            return
        except InterruptedError:
            continue
        if pid == 0:
            return


def _kill_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        return False
    deadline = time.monotonic() + 2
    while True:
        _reap_group(process.pid)
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.01)


def _capture(command, input_data, timeout, transport_fd=None):
    deadline = time.monotonic() + timeout
    env = os.environ.copy()
    env.pop("GIT_CONFIG", None)
    life_write, group_write, supervisor_pid = _start_supervisor()
    try:
        process = subprocess.Popen(
            command,
            env=env,
            stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=lambda: _prepare_child(group_write),
            pass_fds=(group_write,),
            close_fds=True,
        )
    except BaseException:
        os.close(group_write)
        _finish_supervisor(life_write, supervisor_pid, False)
        raise
    os.close(group_write)
    selector = selectors.DefaultSelector()
    streams = {process.stdout: [bytearray(), STDOUT_LIMIT, False], process.stderr: [bytearray(), STDERR_LIMIT, False]}
    active_streams = set(streams)
    written = 0
    timed_out = False
    io_error = None
    transport_error = None
    terminated = False
    try:
        for stream in streams:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ)
        if input_data:
            os.set_blocking(process.stdin.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE)
            active_streams.add(process.stdin)
        elif input_data is not None:
            process.stdin.close()
        if transport_fd is not None:
            selector.register(transport_fd, selectors.EVENT_READ)

        while active_streams:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            events = selector.select(remaining)
            if not events:
                timed_out = True
                break
            for key, _ in events:
                stream = key.fileobj
                if stream == transport_fd:
                    transport_error = EOFError("transport fermé") if not os.read(transport_fd, 1) else ValueError("requête inattendue")
                    break
                if stream is process.stdin:
                    try:
                        count = os.write(stream.fileno(), input_data[written : written + CHUNK])
                        written += count
                        if written == len(input_data):
                            selector.unregister(stream)
                            active_streams.remove(stream)
                            stream.close()
                    except BrokenPipeError:
                        selector.unregister(stream)
                        active_streams.remove(stream)
                        stream.close()
                    continue
                try:
                    chunk = os.read(stream.fileno(), CHUNK)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(stream)
                    active_streams.remove(stream)
                    stream.close()
                    continue
                capture, limit, overflow = streams[stream]
                remaining_capture = max(0, limit - len(capture))
                capture.extend(chunk[:remaining_capture])
                streams[stream][2] = overflow or len(chunk) > remaining_capture
            if transport_error is not None:
                break
        if timed_out or transport_error is not None:
            terminated = _kill_group(process)
        else:
            remaining = max(0.0, deadline - time.monotonic())
            try:
                process.wait(timeout=remaining)
                terminated = _kill_group(process)
            except subprocess.TimeoutExpired:
                timed_out = True
                terminated = _kill_group(process)
    except OSError as error:
        io_error = str(error)
        terminated = _kill_group(process)
    finally:
        selector.close()
        _finish_supervisor(life_write, supervisor_pid, terminated)
        if not terminated:
            terminated = _kill_group(process)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
    if transport_error is not None:
        raise transport_error

    stdout = bytes(streams[process.stdout][0])
    stderr = bytes(streams[process.stderr][0])
    return {
        "status": process.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "stdout_overflow": streams[process.stdout][2],
        "stderr_truncated": streams[process.stderr][2],
        "timeout": timed_out,
        "terminated": terminated,
        "io_error": io_error,
    }


def _config_risks(args_git, timeout, transport_fd=None):
    path, _ = _split_args(args_git)
    probe = [
        "git",
        "--no-replace-objects",
        "--no-pager",
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-C",
        path,
        "config",
        "--includes",
        "--null",
        "--name-only",
        "--list",
    ]
    result = _capture(probe, None, timeout, transport_fd)
    if result["timeout"] or result["io_error"] or not result["terminated"]:
        raise _PreflightCaptureError(result)
    if result["status"] != 0 or result["stdout_overflow"]:
        return None
    names = [name.lower() for name in result["stdout"].split(b"\0") if name]
    partial = any(
        name == b"extensions.partialclone" or (name.startswith(b"remote.") and name.endswith(b".promisor"))
        for name in names
    )
    filters = any(
        name.startswith(b"filter.") and (name.endswith(b".clean") or name.endswith(b".process"))
        for name in names
    )
    return partial, filters


def _has_gitlink(args_git, timeout, transport_fd=None):
    path, _ = _split_args(args_git)
    result = _capture(["git", *_SAFETY_ARGS, *_FIXED_PREFIX, path, "ls-files", "--stage", "-z"], None, timeout, transport_fd)
    if result["timeout"] or result["io_error"] or not result["terminated"]:
        raise _PreflightCaptureError(result)
    if result["status"] != 0 or result["stdout_overflow"]:
        return None
    return any(record.startswith(b"160000 ") for record in result["stdout"].split(b"\0"))


def _worktree_sensitive(command):
    # A commit range never reads the worktree, so clean filters and gitlinks cannot run.
    return command[:1] == ["status"] or (
        command[:1] == ["diff"] and "--cached" not in command and not _is_range_diff(command)
    )


def execute_request(request, transport_fd=None):
    request_id = request.get("id") if isinstance(request, dict) else None
    if not isinstance(request, dict) or set(request) != {"v", "id", "args", "stdin", "timeoutMs"}:
        return _response(request_id, "badRequest", message="Requête malformée.")
    if request["v"] != VERSION or type(request_id) is not int or request_id < 0:
        return _response(request_id, "badRequest", message="Version ou identifiant invalide.")
    args_git = request["args"]
    timeout_ms = request["timeoutMs"]
    if not validate_args(args_git) or type(timeout_ms) is not int or not 1 <= timeout_ms <= MAX_TIMEOUT_MS:
        return _response(request_id, "unsupported", message="Lecture Git non prise en charge.")
    encoded = request["stdin"]
    if encoded is not None and (not isinstance(encoded, str) or len(encoded) > ((STDIN_LIMIT + 2) // 3) * 4):
        return _response(request_id, "badRequest", message="Entrée trop volumineuse.")
    try:
        input_data = None if encoded is None else base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return _response(request_id, "badRequest", message="Entrée base64 invalide.")
    if input_data is not None and len(input_data) > STDIN_LIMIT:
        return _response(request_id, "badRequest", message="Entrée trop volumineuse.")

    started = time.monotonic()
    command = _split_args(args_git)[1]
    if command in (["cat-file", "--batch-check"], ["cat-file", "--batch"]):
        if not _valid_batch_input(input_data):
            return _response(request_id, "badRequest", message="OID groupés invalides.")
    if command == ["--version"]:
        result = _capture(["git", "--version"], input_data, timeout_ms / 1000.0, transport_fd)
    elif command[0] == "switch":
        result = _capture(["git", *args_git], input_data, timeout_ms / 1000.0, transport_fd)
    else:
        try:
            risks = _config_risks(args_git, timeout_ms / 1000.0, transport_fd)
            if risks is None:
                return _response(request_id, "unsupported", message="Innocuité de la lecture Git non vérifiable.")
            partial, filters = risks
            if partial:
                return _response(request_id, "unsupported", message="Clone partiel non pris en charge.")
            remaining = timeout_ms / 1000.0 - (time.monotonic() - started)
            if remaining <= 0:
                return _response(request_id, "timeout", terminated=True)
            if _worktree_sensitive(command):
                if filters:
                    return _response(request_id, "unsupported", message="Filtre de contenu non pris en charge.")
                gitlink = _has_gitlink(args_git, remaining, transport_fd)
                if gitlink is None or gitlink:
                    return _response(request_id, "unsupported", message="Lecture de sous-module non prise en charge.")
                remaining = timeout_ms / 1000.0 - (time.monotonic() - started)
                if remaining <= 0:
                    return _response(request_id, "timeout", terminated=True)
            result = _capture(["git", *_SAFETY_ARGS, *args_git], input_data, remaining, transport_fd)
        except _PreflightCaptureError as error:
            result = error.result
    if result["timeout"]:
        return _response(request_id, "timeout", terminated=result["terminated"])
    if result["io_error"] or not result["terminated"]:
        return _response(request_id, "io", terminated=result["terminated"], message=result["io_error"])
    if result["stdout_overflow"]:
        return _response(request_id, "outputTooLarge", stderr=result["stderr"], stderr_truncated=result["stderr_truncated"])
    kind = "ok" if result["status"] == 0 else "git"
    return _response(
        request_id,
        kind,
        status=result["status"],
        stdout=result["stdout"],
        stderr=result["stderr"],
        stderr_truncated=result["stderr_truncated"],
    )


def _response(request_id, kind, status=None, stdout=b"", stderr=b"", stderr_truncated=False, terminated=True, message=None):
    return {
        "v": VERSION,
        "id": request_id,
        "kind": kind,
        "status": status,
        "stdout": base64.b64encode(stdout).decode("ascii"),
        "stderr": base64.b64encode(stderr).decode("ascii"),
        "stderrTruncated": bool(stderr_truncated),
        "terminated": bool(terminated),
        "message": message,
    }


def _read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            return None
        data.extend(chunk)
    return bytes(data)


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("clé JSON dupliquée")
        value[key] = item
    return value


def read_frame(stream):
    header = _read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack(">I", header)[0]
    if size == 0 or size > REQUEST_FRAME_LIMIT:
        raise ValueError("taille de frame invalide")
    payload = _read_exact(stream, size)
    if payload is None:
        raise EOFError("frame tronquée")
    return json.loads(payload.decode("utf-8"), object_pairs_hook=_unique_object)


def write_frame(stream, value):
    payload = json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    if not payload or len(payload) > RESPONSE_FRAME_LIMIT:
        raise ValueError("réponse trop volumineuse")
    stream.write(struct.pack(">I", len(payload)))
    stream.write(payload)
    stream.flush()


def serve(stdin=None, stdout=None):
    stdin = stdin or sys.stdin.buffer
    stdout = stdout or sys.stdout.buffer
    try:
        transport_fd = stdin.fileno()
    except (AttributeError, io.UnsupportedOperation):
        transport_fd = None
    write_frame(stdout, _response(0, "hello"))
    while True:
        try:
            request = read_frame(stdin)
            if request is None:
                return 0
            write_frame(stdout, execute_request(request, transport_fd))
        except (EOFError, UnicodeError, ValueError, json.JSONDecodeError):
            return 2


if __name__ == "__main__":
    raise SystemExit(serve())
