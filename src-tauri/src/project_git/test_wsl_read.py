import base64
import importlib.util
import io
import json
import os
import pathlib
import signal
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).with_name("wsl_read.py")
SPEC = importlib.util.spec_from_file_location("soreno_wsl_read", MODULE_PATH)
relay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(relay)


def git(*args, cwd=None, input_data=None):
    return subprocess.run(
        ["git", *args], cwd=cwd, input=input_data, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=True,
    ).stdout


def full(path, command):
    return [*relay._FIXED_PREFIX, str(path), *command]


def request(path, command, stdin=None, timeout=5000, request_id=1):
    return {
        "v": 1,
        "id": request_id,
        "args": full(path, command),
        "stdin": None if stdin is None else base64.b64encode(stdin).decode("ascii"),
        "timeoutMs": timeout,
    }


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def child_pids(pid):
    try:
        value = pathlib.Path(f"/proc/{pid}/task/{pid}/children").read_text()
    except (FileNotFoundError, ProcessLookupError):
        return []
    return [int(value) for value in value.split()]


def reap(pid):
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.path = "/tmp/a b;$(touch nope)\nline"

    def assert_allowed(self, *command):
        self.assertTrue(relay.validate_args(full(self.path, list(command))), command)

    def assert_refused(self, *command):
        self.assertFalse(relay.validate_args(full(self.path, list(command))), command)

    def test_exact_display_reads_are_allowed(self):
        oid = "a" * 40
        self.assert_allowed("--version")
        self.assert_allowed("symbolic-ref", "--quiet", "--short", "HEAD")
        self.assert_allowed("rev-parse", "--short", "HEAD")
        self.assert_allowed("rev-parse", "--verify", "-q", "HEAD^{commit}")
        self.assert_allowed("rev-parse", "--verify", "--quiet", oid + "^{commit}")
        self.assert_allowed("merge-base", oid, oid)
        self.assert_allowed("diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--raw", "--numstat", "-z", "--no-abbrev", "-M", oid, oid, "--")
        self.assert_allowed("status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all")
        self.assert_allowed("diff", "--no-ext-diff", "--no-textconv", "--cached", "--numstat", "-z", "--")
        self.assert_allowed("ls-files", "--stage", "-z")
        self.assert_allowed("ls-tree", "-z", oid, "--", ":(literal)a b\nfile")
        self.assert_allowed("cat-file", "-s", oid)
        self.assert_allowed("cat-file", "blob", oid)
        self.assert_allowed("cat-file", "--batch-check")
        self.assert_allowed("cat-file", "--batch")
        self.assert_allowed("log", "--no-ext-diff", "--no-textconv", "--no-show-signature", "-z", "--format=%H%x00%an%x00%cI%x00%s", "--max-count", "51", "--skip", "0", oid)
        self.assert_allowed("log", "--no-ext-diff", "--no-textconv", "--no-show-signature", "--no-relative", "-1", "--format=%H%x00%P", "--root", "--diff-merges=first-parent", "--raw", "--numstat", "-z", "--no-abbrev", "-M", oid, "--")
        self.assert_allowed("for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(symref)", "refs/heads", "refs/remotes")
        self.assert_allowed("remote")
        self.assert_allowed("remote", "get-url", "--push", "--all", "origin")
        self.assert_allowed("hash-object", "--no-filters", "--stdin-paths")
        self.assert_allowed("switch", "--no-overwrite-ignore", "--no-guess", "feature/éclair")
        self.assert_allowed("switch", "--no-overwrite-ignore", "--track", "-c", "topic", "refs/remotes/origin/topic")

    def test_removed_stash_display_reads_are_refused(self):
        oid = "a" * 40
        self.assert_refused("diff-tree", "--no-ext-diff", "--no-textconv", "--no-relative", "-r", "-M", "--no-commit-id", "--no-abbrev", "--raw", "--numstat", "-z", oid, oid, "--")
        self.assert_refused("rev-list", "--parents", "-n", "1", oid)
        self.assert_refused("log", "--no-ext-diff", "--no-textconv", "--no-show-signature", "-g", "--format=%H%x00%gd%x00%cI%x00%s", "--glob=refs/stas[h]")
        self.assert_refused("ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z")
        self.assert_refused("ls-tree", "-r", "--name-only", "-z", oid)

    def test_writes_and_unsafe_execution_paths_are_refused(self):
        refused = [
            ("add", "file"),
            ("commit", "-m", "no"),
            ("switch", "feature"),
            ("switch", "--no-overwrite-ignore", "--no-guess", "-hostile"),
            ("switch", "--no-overwrite-ignore", "--track", "-c", "topic", "origin/topic"),
            ("symbolic-ref", "HEAD", "refs/heads/other"),
            ("symbolic-ref", "--quiet", "--short", "refs/heads/main"),
            ("symbolic-ref", "--quiet", "--short", "HEAD", "extra"),
            ("symbolic-ref", "--short", "HEAD"),
            ("rev-parse", "--short=8", "HEAD"),
            ("rev-parse", "--short", "refs/heads/main"),
            ("rev-parse", "--short", "HEAD", "extra"),
            ("rev-parse", "--verify", "--quiet", "a" * 40),
            ("rev-parse", "--verify", "--quiet", "--all^{commit}"),
            ("merge-base", "--is-ancestor", "a" * 40, "a" * 40),
            ("merge-base", "--octopus", "a" * 40),
            ("merge-base", "a" * 40, "a" * 40, "a" * 40),
            ("diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--raw", "--numstat", "-z", "--no-abbrev", "-M", "a" * 40, "--output=/tmp/pwned", "--"),
            ("diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--raw", "--numstat", "-z", "--no-abbrev", "-M", "a" * 40, "a" * 40),
            ("diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--raw", "--numstat", "-z", "--no-abbrev", "-M", "a" * 40, "a" * 40 + "^@", "--"),
            ("diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--raw", "--numstat", "-z", "--no-abbrev", "-M", "a" * 40 + "^@", "a" * 40, "--"),
            ("diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--raw", "--numstat", "-z", "--no-abbrev", "-M", "a" * 12, "a" * 40, "--"),
            ("diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--raw", "--numstat", "-z", "--no-abbrev", "-M", "A" * 40, "a" * 40, "--"),
            ("diff", "--no-relative", "--raw", "--numstat", "-z", "--no-abbrev", "-M", "a" * 40, "a" * 40, "--"),
            ("diff", "--relative", "--raw", "--numstat", "-z", "--no-abbrev", "-M", "a" * 40, "a" * 40, "--"),
            ("stash", "push"),
            ("remote", "add", "x", "y"),
            ("hash-object", "-w", "--stdin"),
            ("diff", "--no-ext-diff", "--no-textconv", "--output=/tmp/pwned"),
            ("log", "--show-signature"),
            ("log", "--no-ext-diff", "--no-textconv", "-z", "--format=%H%x00%an%x00%cI%x00%s", "--max-count", "51", "--skip", "0", "a" * 40),
            ("log", "--no-ext-diff", "--no-textconv", "--no-relative", "-1", "--format=%H%x00%P", "--root", "--diff-merges=first-parent", "--raw", "--numstat", "-z", "--no-abbrev", "-M", "a" * 40, "--"),
            ("log", "--no-ext-diff", "--no-textconv", "-g", "--format=%H%x00%gd%x00%cI%x00%s", "--glob=refs/stas[h]"),
            ("stash", "list", "--format=%H%x00%gd%x00%cI%x00%s"),
            ("cat-file", "--filters", "HEAD:file"),
            ("cat-file", "--batch-check", "--follow-symlinks"),
            ("cat-file", "--batch", "--textconv"),
            ("cat-file", "--batch", "--filters"),
            ("cat-file", "--batch", "--buffer"),
            ("cat-file", "--batch", "--output=/tmp/pwned"),
            ("diff-tree", "--no-ext-diff", "--no-textconv", "-r", "-M", "--no-commit-id", "--no-abbrev", "--raw", "--numstat", "-z", "a" * 40, "a" * 40, "--"),
            ("diff-tree", "--no-ext-diff", "--no-textconv", "--relative", "-r", "-M", "--no-commit-id", "--no-abbrev", "--raw", "--numstat", "-z", "a" * 40, "a" * 40, "--"),
            ("log", "--no-ext-diff", "--no-textconv", "-1", "--format=%H%x00%P", "--root", "--diff-merges=first-parent", "--raw", "--numstat", "-z", "--no-abbrev", "-M", "a" * 40, "--"),
            ("log", "--no-ext-diff", "--no-textconv", "--relative", "-1", "--format=%H%x00%P", "--root", "--diff-merges=first-parent", "--raw", "--numstat", "-z", "--no-abbrev", "-M", "a" * 40, "--"),
            ("for-each-ref", "--format=%(refname)%00%(upstream:short)%00%(HEAD)%00%(symref)", "refs/heads", "refs/remotes"),
            ("-c", "alias.x=!touch /tmp/pwned", "x"),
        ]
        for command in refused:
            self.assert_refused(*command)

    def test_batch_input_accepts_only_one_or_two_literal_oids(self):
        oid = b"a" * 40
        for stdin in (None, b"", oid, b"HEAD\n", oid + b"\n\n", oid + b"\n" + oid + b"\n" + oid + b"\n"):
            with self.subTest(stdin=stdin):
                response = relay.execute_request(request(self.path, ["cat-file", "--batch"], stdin))
                self.assertEqual(response["kind"], "badRequest")
        self.assertTrue(relay._valid_batch_input(oid + b"\n"))
        self.assertTrue(relay._valid_batch_input(b"B" * 64 + b"\n" + b"c" * 64 + b"\n"))

    def test_python_timeout_is_capped_at_two_minutes(self):
        response = relay.execute_request(request(pathlib.Path(self.path), ["--version"], timeout=120001))
        self.assertEqual(response["kind"], "unsupported")


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soreno-wsl-read-")
        self.root = pathlib.Path(self.temp.name)
        git("init", "-q", cwd=self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_exact_branch_switch_executes_without_a_new_wsl_transport(self):
        (self.root / "tracked").write_text("content")
        git("add", "tracked", cwd=self.root)
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial", cwd=self.root)
        git("branch", "feature", cwd=self.root)

        response = relay.execute_request(request(
            self.root,
            ["switch", "--no-overwrite-ignore", "--no-guess", "feature"],
        ))

        self.assertEqual(response["kind"], "ok")
        self.assertEqual(git("branch", "--show-current", cwd=self.root).strip(), b"feature")

    def test_branch_probes_execute_for_unborn_normal_and_detached_head(self):
        symbolic = ["symbolic-ref", "--quiet", "--short", "HEAD"]
        short_oid = ["rev-parse", "--short", "HEAD"]

        unborn_branch = relay.execute_request(request(self.root, symbolic))
        unborn_oid = relay.execute_request(request(self.root, short_oid))
        self.assertEqual(unborn_branch["kind"], "ok")
        self.assertEqual(base64.b64decode(unborn_branch["stdout"]).strip(), git(*symbolic, cwd=self.root).strip())
        self.assertEqual(unborn_oid["kind"], "git")

        (self.root / "tracked").write_text("content")
        git("add", "tracked", cwd=self.root)
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial", cwd=self.root)
        normal_branch = relay.execute_request(request(self.root, symbolic))
        normal_oid = relay.execute_request(request(self.root, short_oid))
        self.assertEqual(normal_branch["kind"], "ok")
        self.assertEqual(base64.b64decode(normal_branch["stdout"]).strip(), git(*symbolic, cwd=self.root).strip())
        self.assertEqual(normal_oid["kind"], "ok")
        self.assertEqual(base64.b64decode(normal_oid["stdout"]).strip(), git(*short_oid, cwd=self.root).strip())

        git("checkout", "--detach", "-q", "HEAD", cwd=self.root)
        detached_branch = relay.execute_request(request(self.root, symbolic))
        detached_oid = relay.execute_request(request(self.root, short_oid))
        self.assertEqual(detached_branch["kind"], "git")
        self.assertEqual(detached_oid["kind"], "ok")
        self.assertEqual(base64.b64decode(detached_oid["stdout"]).strip(), git(*short_oid, cwd=self.root).strip())

    def test_literal_metacharacters_are_not_a_shell_and_binary_data_round_trips(self):
        marker = self.root / "injected"
        malicious = f"HEAD; touch {marker}"
        response = relay.execute_request(request(self.root, ["rev-parse", "--verify", malicious]))
        self.assertEqual(response["kind"], "git")
        self.assertFalse(marker.exists())

        content = "été\n".encode() + b"\0tail"
        oid = git("hash-object", "-w", "--stdin", cwd=self.root, input_data=content).decode().strip()
        response = relay.execute_request(request(self.root, ["cat-file", "blob", oid]))
        self.assertEqual(response["kind"], "ok")
        self.assertEqual(base64.b64decode(response["stdout"]), content)
        batch_input = (oid + "\n").encode()
        checked = relay.execute_request(request(self.root, ["cat-file", "--batch-check"], batch_input))
        self.assertEqual(checked["kind"], "ok")
        self.assertEqual(base64.b64decode(checked["stdout"]), f"{oid} blob {len(content)}\n".encode())
        batch = relay.execute_request(request(self.root, ["cat-file", "--batch"], batch_input))
        self.assertEqual(batch["kind"], "ok")
        self.assertEqual(
            base64.b64decode(batch["stdout"]),
            f"{oid} blob {len(content)}\n".encode() + content + b"\n",
        )

    def test_output_and_error_captures_are_bounded(self):
        too_large = b"x" * (relay.STDOUT_LIMIT + 1)
        oid = git("hash-object", "-w", "--stdin", cwd=self.root, input_data=too_large).decode().strip()
        response = relay.execute_request(request(self.root, ["cat-file", "blob", oid], timeout=15000))
        self.assertEqual(response["kind"], "outputTooLarge")

        script = "import os; os.write(2, b'e' * %d)" % (relay.STDERR_LIMIT + 37)
        captured = relay._capture([sys.executable, "-c", script], None, 5)
        self.assertEqual(len(captured["stderr"]), relay.STDERR_LIMIT)
        self.assertTrue(captured["stderr_truncated"])

    def test_timeout_kills_and_reaps_the_process_group(self):
        pids = self.root / "pids"
        child = (
            "import os,subprocess,time,pathlib; "
            "p=subprocess.Popen(['sleep','30']); "
            f"pathlib.Path({str(pids)!r}).write_text(f'{{os.getpid()}} {{p.pid}}'); "
            "time.sleep(30)"
        )
        # Allow interpreter/descendant startup even when other suites load the CPU.
        captured = relay._capture([sys.executable, "-c", child], None, 1)
        self.assertTrue(captured["timeout"])
        self.assertTrue(captured["terminated"])
        for pid in map(int, pids.read_text().split()):
            self.assertFalse(alive(pid))

    def test_normal_exit_also_kills_and_reaps_descendants(self):
        pid_file = self.root / "normal-child"
        child = (
            "import subprocess,pathlib; "
            "p=subprocess.Popen(['sleep','30'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
            f"pathlib.Path({str(pid_file)!r}).write_text(str(p.pid))"
        )
        pid = None
        try:
            captured = relay._capture([sys.executable, "-c", child], None, 5)
            pid = int(pid_file.read_text())
            self.assertEqual(captured["status"], 0)
            self.assertTrue(captured["terminated"])
            self.assertFalse(alive(pid))
        finally:
            if pid is not None and alive(pid):
                os.kill(pid, signal.SIGKILL)

    def test_killing_relay_triggers_life_pipe_supervisor(self):
        pids = self.root / "killed-pids"
        target = (
            "import os,subprocess,time,pathlib; "
            "p=subprocess.Popen(['sleep','30']); "
            f"pathlib.Path({str(pids)!r}).write_text(f'{{os.getpid()}} {{p.pid}}'); "
            "time.sleep(30)"
        )
        harness = (
            "import importlib.util,sys; "
            f"s=importlib.util.spec_from_file_location('r',{str(MODULE_PATH)!r}); "
            "r=importlib.util.module_from_spec(s); s.loader.exec_module(r); "
            f"r._capture([sys.executable,'-c',{target!r}],None,30)"
        )
        process = subprocess.Popen([sys.executable, "-c", harness])
        deadline = time.monotonic() + 5
        while not pids.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(pids.exists())
        process.kill()
        process.wait(timeout=2)
        descendants = list(map(int, pids.read_text().split()))
        deadline = time.monotonic() + 3
        while any(alive(pid) for pid in descendants) and time.monotonic() < deadline:
            for pid in descendants:
                reap(pid)
            time.sleep(0.02)
        for pid in descendants:
            reap(pid)
        self.assertFalse(any(alive(pid) for pid in descendants))

    def test_protocol_process_serves_a_request_and_eof_shuts_it_down(self):
        with subprocess.Popen(
            [sys.executable, "-I", "-S", "-u", "-c", MODULE_PATH.read_text()],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as process:
            hello = relay.read_frame(process.stdout)
            self.assertEqual(hello["kind"], "hello")
            relay.write_frame(process.stdin, request(self.root, ["remote"]))
            response = relay.read_frame(process.stdout)
            self.assertEqual(response["kind"], "ok")
            process.stdin.close()
            self.assertEqual(process.wait(timeout=2), 0)
            self.assertEqual(process.stderr.read(), b"")

    def test_frames_are_versioned_bounded_and_eof_is_clean(self):
        output = io.BytesIO()
        relay.write_frame(output, relay._response(0, "hello", stdout="utf8-é".encode() + b"\0"))
        raw = output.getvalue()
        size = struct.unpack(">I", raw[:4])[0]
        decoded = json.loads(raw[4 : 4 + size])
        self.assertEqual(decoded["v"], 1)
        self.assertEqual(base64.b64decode(decoded["stdout"]), b"utf8-\xc3\xa9\0")
        self.assertIsNone(relay.read_frame(io.BytesIO()))
        with self.assertRaises(ValueError):
            relay.read_frame(io.BytesIO(struct.pack(">I", relay.REQUEST_FRAME_LIMIT + 1)))
        with self.assertRaises(EOFError):
            relay.read_frame(io.BytesIO(struct.pack(">I", 5) + b"{}"))
        duplicate = b'{"v":1,"v":2}'
        with self.assertRaises(ValueError):
            relay.read_frame(io.BytesIO(struct.pack(">I", len(duplicate)) + duplicate))

    def test_effective_filter_config_blocks_only_worktree_reads(self):
        (self.root / ".gitattributes").write_text("tracked filter=unsafe\n")
        (self.root / "tracked").write_text("before\n")
        git("add", ".", cwd=self.root)
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial", cwd=self.root)
        marker = self.root / "filter-ran"
        included = self.root / "filters.config"
        git("config", "--file", str(included), "filter.unsafe.clean", f"touch {marker}; cat")
        git("config", "--local", "include.path", str(included), cwd=self.root)
        (self.root / "tracked").write_text("after\n")

        status = relay.execute_request(request(self.root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]))
        diff = relay.execute_request(request(self.root, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--"]))
        oid = git("rev-parse", "HEAD", cwd=self.root).decode().strip()
        range_diff = relay.execute_request(request(self.root, [
            "diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--raw", "--numstat", "-z", "--no-abbrev", "-M", oid, oid, "--",
        ]))
        archive = relay.execute_request(request(self.root, [
            "log", "--no-ext-diff", "--no-textconv", "--no-show-signature", "--no-relative", "-1", "--format=%H%x00%P", "--root",
            "--diff-merges=first-parent", "--raw", "--numstat", "-z", "--no-abbrev", "-M", oid, "--",
        ]))

        self.assertEqual(status["kind"], "unsupported")
        self.assertEqual(diff["kind"], "unsupported")
        self.assertEqual(archive["kind"], "ok")
        self.assertEqual(range_diff["kind"], "ok")
        self.assertFalse(marker.exists())
        self.assertNotIn(str(marker), json.dumps(status))

    def test_inherited_git_config_cannot_mask_repository_filters(self):
        (self.root / ".gitattributes").write_text("tracked filter=unsafe\n")
        (self.root / "tracked").write_text("before\n")
        git("add", ".", cwd=self.root)
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial", cwd=self.root)
        content = b"immutable\n"
        oid = git("hash-object", "-w", "--stdin", cwd=self.root, input_data=content).decode().strip()
        inherited = self.root / "empty.config"
        inherited.touch()
        (self.root / "tracked").write_text("after\n")

        for setting in ("clean", "process"):
            with self.subTest(setting=setting):
                marker = self.root / f"{setting}-filter-ran"
                git("config", "--local", f"filter.unsafe.{setting}", f"touch {marker}; cat", cwd=self.root)
                with mock.patch.dict(os.environ, {"GIT_CONFIG": str(inherited)}):
                    status = relay.execute_request(request(self.root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]))
                    diff = relay.execute_request(request(self.root, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--"]))
                    blob = relay.execute_request(request(self.root, ["cat-file", "blob", oid]))
                    self.assertEqual(os.environ["GIT_CONFIG"], str(inherited))
                git("config", "--local", "--unset-all", f"filter.unsafe.{setting}", cwd=self.root)

                self.assertEqual(status["kind"], "unsupported")
                self.assertEqual(diff["kind"], "unsupported")
                self.assertEqual(blob["kind"], "ok")
                self.assertEqual(base64.b64decode(blob["stdout"]), content)
                self.assertFalse(marker.exists())

    def test_global_process_filter_does_not_block_immutable_reads(self):
        (self.root / "tracked").write_text("content")
        git("add", "tracked", cwd=self.root)
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial", cwd=self.root)
        commit_oid = git("rev-parse", "HEAD", cwd=self.root).strip()
        global_config = self.root / "global.config"
        marker = self.root / "global-filter-ran"
        git("config", "--file", str(global_config), "filter.lfs.process", f"touch {marker}")
        previous = os.environ.get("GIT_CONFIG_GLOBAL")
        os.environ["GIT_CONFIG_GLOBAL"] = str(global_config)
        try:
            status = relay.execute_request(request(self.root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]))
            branches = relay.execute_request(request(self.root, [
                "for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(symref)",
                "refs/heads", "refs/remotes",
            ]))
            content = b"immutable\0blob\n"
            oid = git("hash-object", "-w", "--stdin", cwd=self.root, input_data=content).decode().strip()
            blob = relay.execute_request(request(
                self.root, ["cat-file", "--batch"], (oid + "\n").encode()
            ))
        finally:
            if previous is None:
                os.environ.pop("GIT_CONFIG_GLOBAL", None)
            else:
                os.environ["GIT_CONFIG_GLOBAL"] = previous
        self.assertEqual(status["kind"], "unsupported")
        self.assertEqual(branches["kind"], "ok")
        branch_fields = base64.b64decode(branches["stdout"]).strip().split(b"\0")
        self.assertEqual(branch_fields[1], commit_oid)
        self.assertEqual(blob["kind"], "ok")
        self.assertIn(content, base64.b64decode(blob["stdout"]))
        self.assertFalse(marker.exists())

    def test_gitlink_blocks_status_but_not_archive_or_cached_numstat(self):
        (self.root / "tracked").write_text("content")
        git("add", "tracked", cwd=self.root)
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial", cwd=self.root)
        oid = git("rev-parse", "HEAD", cwd=self.root).decode().strip()
        git("update-index", "--add", "--cacheinfo", f"160000,{oid},nested", cwd=self.root)
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "gitlink", cwd=self.root)
        oid = git("rev-parse", "HEAD", cwd=self.root).decode().strip()
        parent = git("rev-parse", f"{oid}~1", cwd=self.root).decode().strip()
        marker = self.root / "submodule-command-ran"
        git("config", "submodule.nested.update", f"!touch {marker}", cwd=self.root)

        status = relay.execute_request(request(self.root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]))
        cached = relay.execute_request(request(self.root, ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--numstat", "-z", "--"]))
        archive = relay.execute_request(request(self.root, [
            "log", "--no-ext-diff", "--no-textconv", "--no-show-signature", "--no-relative", "-1", "--format=%H%x00%P", "--root",
            "--diff-merges=first-parent", "--raw", "--numstat", "-z", "--no-abbrev", "-M", oid, "--",
        ]))
        range_diff = relay.execute_request(request(self.root, [
            "diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--raw", "--numstat", "-z", "--no-abbrev", "-M", parent, oid, "--",
        ]))
        probe = relay.execute_request(request(self.root, ["rev-parse", "--verify", "--quiet", f"{oid}^{{commit}}"]))
        base = relay.execute_request(request(self.root, ["merge-base", f"{oid}~1", oid]))
        self.assertEqual(status["kind"], "unsupported")
        self.assertEqual(cached["kind"], "ok")
        self.assertEqual(archive["kind"], "ok")
        self.assertEqual(range_diff["kind"], "ok")
        self.assertIn(b"160000", base64.b64decode(range_diff["stdout"]))
        self.assertEqual(base64.b64decode(probe["stdout"]).strip().decode(), oid)
        self.assertEqual(base64.b64decode(base["stdout"]).strip(), git("rev-parse", f"{oid}~1", cwd=self.root).strip())
        self.assertFalse(marker.exists())

    def test_partial_clone_in_included_bare_config_never_fetches(self):
        bare = self.root / "bare.git"
        git("init", "--bare", "-q", str(bare))
        included = self.root / "promisor.config"
        git("config", "--file", str(included), "remote.origin.promisor", "true")
        git("config", "--file", str(bare / "config"), "include.path", str(included))
        before = sorted((path.relative_to(bare / "objects"), path.read_bytes()) for path in (bare / "objects").rglob("*") if path.is_file())
        response = relay.execute_request(request(
            bare, ["cat-file", "--batch-check"], ("a" * 40 + "\n").encode()
        ))
        after = sorted((path.relative_to(bare / "objects"), path.read_bytes()) for path in (bare / "objects").rglob("*") if path.is_file())
        self.assertEqual(response["kind"], "unsupported")
        self.assertEqual(after, before)
        self.assertEqual(list((bare / "objects" / "pack").glob("*.promisor")), [])

    def test_partial_clone_is_detected_in_worktree_and_global_config(self):
        git("config", "extensions.worktreeConfig", "true", cwd=self.root)
        git("config", "--worktree", "extensions.partialClone", "origin", cwd=self.root)
        self.assertEqual(relay.execute_request(request(self.root, ["remote"]))["kind"], "unsupported")
        git("config", "--worktree", "--unset", "extensions.partialClone", cwd=self.root)

        global_config = self.root / "partial-global.config"
        git("config", "--file", str(global_config), "remote.origin.promisor", "true")
        previous = os.environ.get("GIT_CONFIG_GLOBAL")
        os.environ["GIT_CONFIG_GLOBAL"] = str(global_config)
        try:
            response = relay.execute_request(request(self.root, ["remote"]))
        finally:
            if previous is None:
                os.environ.pop("GIT_CONFIG_GLOBAL", None)
            else:
                os.environ["GIT_CONFIG_GLOBAL"] = previous
        self.assertEqual(response["kind"], "unsupported")

    def test_version_ignores_repository_path_and_preflight(self):
        response = relay.execute_request(request(self.root / "missing" / "repo", ["--version"]))
        self.assertEqual(response["kind"], "ok")
        self.assertTrue(base64.b64decode(response["stdout"]).startswith(b"git version "))

    def test_request_deadline_can_expire_before_git_starts(self):
        original = relay._config_risks
        try:
            relay._config_risks = lambda _args, timeout, _fd=None: (time.sleep(timeout + 0.01), (False, False))[1]
            response = relay.execute_request(request(self.root, ["remote"], timeout=1))
        finally:
            relay._config_risks = original
        self.assertEqual(response["kind"], "timeout")

    def test_preflight_capture_failures_preserve_kind_and_termination(self):
        safe = {
            "status": 0,
            "stdout": b"",
            "stderr": b"",
            "stdout_overflow": False,
            "stderr_truncated": False,
            "timeout": False,
            "terminated": True,
            "io_error": None,
        }
        failures = (
            ("uncertain-timeout", {"timeout": True, "terminated": False}, "timeout", False),
            ("uncertain-io", {"io_error": "capture impossible", "terminated": False}, "io", False),
            ("uncertain-termination", {"terminated": False}, "io", False),
            ("confirmed-timeout", {"timeout": True}, "timeout", True),
            ("confirmed-io", {"io_error": "capture impossible"}, "io", True),
        )
        command = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]
        for preflight, prefix in (("config", []), ("gitlink", [safe])):
            for outcome, changes, expected_kind, expected_terminated in failures:
                failed = {**safe, "stdout": b"secret-config-value", **changes}
                with self.subTest(preflight=preflight, outcome=outcome):
                    with mock.patch.object(relay, "_capture", side_effect=[*prefix, failed]) as capture:
                        response = relay.execute_request(request(self.root, command))
                    self.assertEqual(response["kind"], expected_kind)
                    self.assertEqual(response["terminated"], expected_terminated)
                    self.assertEqual(capture.call_count, len(prefix) + 1)
                    self.assertNotIn("secret-config-value", json.dumps(response))

    def test_protocol_eof_during_git_kills_git_and_relay_immediately(self):
        fifo = self.root / "blocked"
        os.mkfifo(fifo)
        process = subprocess.Popen(
            [sys.executable, "-I", "-S", "-u", "-c", MODULE_PATH.read_text()],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        git_pid = None
        try:
            self.assertEqual(relay.read_frame(process.stdout)["kind"], "hello")
            relay.write_frame(process.stdin, request(self.root, ["hash-object", "--no-filters", "--stdin-paths"], b"blocked\n", timeout=15000))
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and git_pid is None:
                for pid in child_pids(process.pid):
                    try:
                        command = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes()
                    except FileNotFoundError:
                        continue
                    if b"hash-object" in command:
                        git_pid = pid
                        break
                time.sleep(0.01)
            self.assertIsNotNone(git_pid)
            closed_at = time.monotonic()
            process.stdin.close()
            self.assertEqual(process.wait(timeout=2), 2)
            self.assertLess(time.monotonic() - closed_at, 2)
            self.assertIsNone(relay.read_frame(process.stdout))
            self.assertFalse(alive(git_pid))
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)
            if git_pid is not None and alive(git_pid):
                try:
                    os.killpg(git_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.stdout.close()
            process.stderr.close()


if __name__ == "__main__":
    unittest.main()
