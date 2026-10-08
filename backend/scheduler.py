"""
SchedulerManipulator - changes how the Linux kernel schedules a process.

Every method runs a real Linux command, which makes the matching system call:
    renice  -> setpriority()        (nice value / CFS weight)
    taskset -> sched_setaffinity()  (which CPU cores the process may use)
    chrt    -> sched_setscheduler() (scheduling policy, e.g. back to SCHED_OTHER)

Raising priority (a negative nice value) needs root. If the backend is not
running as root, commands are run through `sudo -n`, which works when sudoers
allows them without a password (see the README).
"""
import os
import subprocess

import psutil


class SchedulerManipulator:

    def __init__(self):
        self.is_root = os.geteuid() == 0
        # Prefix for commands that always need root (the real-time demo)
        self.prefix = [] if self.is_root else ["sudo", "-n"]

    @staticmethod
    def _exec(cmd):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.TimeoutExpired) as e:
            return False, str(e)
        return r.returncode == 0, (r.stdout.strip() or r.stderr.strip())

    def _run(self, *cmd):
        """Run a command; if it fails without root, retry through `sudo -n`.
        Returns (ok, message)."""
        ok, msg = self._exec(list(cmd))
        if not ok and not self.is_root:
            ok, msg = self._exec(["sudo", "-n"] + list(cmd))
        return ok, msg

    def inflate_priority(self, pid: int, nice_val: int = -15):
        """Change the nice value (-20 = most CPU, +19 = least)."""
        return self._run("renice", "-n", str(nice_val), "-p", str(pid))

    def pin_to_core(self, pid: int, core: int = 0):
        """Restrict a process to a single CPU core."""
        return self._run("taskset", "-cp", str(core), str(pid))

    def unpin(self, pid: int):
        """Allow a process to run on every CPU core again."""
        count = psutil.cpu_count()
        return self._run("taskset", "-cp", f"0-{count - 1}", str(pid))

    def restore_normal(self, pid: int):
        """Nice 0, normal CFS policy (SCHED_OTHER), all cores."""
        results = [
            self._run("renice", "-n", "0", "-p", str(pid)),
            self._run("chrt", "-o", "-p", "0", str(pid)),
            self.unpin(pid),
        ]
        ok = all(r[0] for r in results)
        return ok, "; ".join(r[1] for r in results if r[1])

    def get_process_stats(self, filter_pids=None):
        """Live process data read from /proc by psutil."""
        stats = []
        for proc in psutil.process_iter(['pid', 'name', 'nice', 'cpu_percent',
                                         'status', 'cpu_affinity']):
            try:
                info = proc.info
                if filter_pids is None or info['pid'] in filter_pids:
                    stats.append(info)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return stats
